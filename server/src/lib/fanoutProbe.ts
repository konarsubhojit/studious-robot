/**
 * Cross-instance socket fan-out self-test.
 *
 * `stateAffinity: 'shared'` only says this instance found a `REDIS_URL`: it
 * describes the call registry, sessions and cache, all of which can be
 * perfectly healthy while an event emitted here never reaches a socket held by
 * the other VM.  That happens whenever the two instances end up on *different*
 * fan-out transports (a partially rolled-out adapter change), or when one
 * instance's adapter clients fail while its command client stays up.  Both
 * failure modes are silent: the sending instance simply cannot see the remote
 * socket, classifies the device as offline and falls back to push.
 *
 * So fan-out is measured rather than inferred.  Every instance periodically
 * emits a probe *through the adapter itself* — `serverSideEmit`, the same
 * cross-instance channel room broadcasts travel over — stamped with its own
 * `instanceId` and the transport it is using.  Each instance remembers the
 * peers it heard from recently, and `/health` reports that set alongside (and
 * deliberately orthogonal to) `stateAffinity`.
 *
 * The cost is one small message per instance per interval on a dedicated
 * channel; no user room is involved.
 */

import {
  DEFAULT_FANOUT_PROBE_INTERVAL_MS,
  DEFAULT_FANOUT_PROBE_STALE_INTERVALS,
} from '../config.ts';
import { describeError } from './errors.ts';
import { sanitizeForLog } from './normalize.ts';

/** Event name the probe travels under.  Namespaced so it cannot collide with a client event. */
const FANOUT_PROBE_EVENT = 'fanout.probe';

/** What a probing instance says about itself. */
type FanoutProbeMessage = {
  instanceId: string;
  transport: string;
  ts: number;
};

/** Fan-out health as reported by `GET /health`. */
type FanoutStatus = {
  /** Fan-out transport this instance is using, e.g. `redis-adapter`. */
  transport: string;
  /** `false` when the adapter cannot carry cross-instance messages at all (single-process mode). */
  probing: boolean;
  /** `instanceId`s heard from within the staleness window. */
  peersSeen: string[];
  /** Age of the most recent peer probe, or `null` when none has ever arrived. */
  lastPeerEventAgeMs: number | null;
  /** `true` when a peer reported a different transport than this instance uses. */
  mixedTransport: boolean;
  /** `false` when a probing instance has heard from no peer, or the fleet is mixed. */
  healthy: boolean;
};

type FanoutProbe = {
  /** Snapshot for `/health`. */
  getStatus: (now?: number) => FanoutStatus;
  /** Emit one probe. Called on a timer; exposed so tests need no wall clock. */
  emitProbe: () => void;
  /** Stop the timer and detach the listener. */
  stop: () => void;
};

/**
 * The slice of `socket.io`'s `Server` the probe uses.  Narrow on purpose: the
 * probe only needs the main namespace's server-to-server channel, and a
 * structural type keeps it testable without a real Socket.IO server.
 */
type ProbeNamespace = {
  serverSideEmit: (event: string, payload: unknown) => unknown;
  on: (event: string, handler: (payload: unknown) => void) => unknown;
  off?: (event: string, handler: (payload: unknown) => void) => unknown;
  adapter?: object | null;
};
type ProbeServer = { of: (namespace: string) => ProbeNamespace };

/**
 * Name the fan-out transport from the adapter instance in use.
 *
 * The base `Adapter` shipped with Socket.IO is process-local — its
 * `serverSideEmit` only warns — so it is reported as `in-memory` and the probe
 * stays off.  Anything else is a cross-instance adapter and is named after its
 * class, which is what makes a mixed-transport fleet visible rather than
 * inferred from a peer that never shows up.
 */
function describeTransport(adapter: object | null | undefined): string {
  const name = adapter?.constructor?.name;
  if (!name) return 'unknown';
  if (name === 'Adapter' || name === 'SessionAwareAdapter') return 'in-memory';
  if (name === 'RedisAdapter') return 'redis-adapter';
  if (name === 'ShardedRedisAdapter') return 'sharded-redis-adapter';
  return name;
}

/** Longest peer-supplied string kept, so one malformed probe cannot bloat the peer map or a log line. */
const MAX_PROBE_FIELD_CHARS = 64;

/** Narrow an arriving payload; anything malformed is ignored rather than trusted. */
function parseProbe(payload: unknown): FanoutProbeMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { instanceId, transport } = payload as Record<string, unknown>;
  if (typeof instanceId !== 'string' || instanceId === '') return null;
  return {
    instanceId: instanceId.slice(0, MAX_PROBE_FIELD_CHARS),
    transport:
      typeof transport === 'string' && transport !== ''
        ? transport.slice(0, MAX_PROBE_FIELD_CHARS)
        : 'unknown',
    // Local receipt time, not the sender's `ts`: peer clocks are not
    // comparable, and skew would otherwise show up as a negative or absurd
    // `lastPeerEventAgeMs`.
    ts: Date.now(),
  };
}

/**
 * Start the fan-out probe for this instance.
 *
 * @param io - Socket.IO server (or a structural stand-in) to probe over.
 * @param instanceId - This instance's identity, as reported by `/health`.
 * @param intervalMs - Probe period; `0` starts no timer (tests drive `emitProbe`).
 * @param staleIntervals - How many missed intervals retire a peer.
 */
function createFanoutProbe({
  io,
  instanceId,
  intervalMs = DEFAULT_FANOUT_PROBE_INTERVAL_MS,
  staleIntervals = DEFAULT_FANOUT_PROBE_STALE_INTERVALS,
}: {
  io: ProbeServer;
  instanceId: string;
  intervalMs?: number;
  staleIntervals?: number;
}): FanoutProbe {
  const namespace = io.of('/');
  const transport = describeTransport(namespace.adapter);
  // A process-local adapter has no peers by construction, and its
  // `serverSideEmit` logs a warning on every call — so probing it would only
  // produce noise and a permanently empty peer set.
  const probing = transport !== 'in-memory';
  const staleAfterMs = Math.max(intervalMs, 1) * Math.max(staleIntervals, 1);
  /** instanceId → { transport, lastSeenAt } for peers heard from. */
  const peers = new Map<string, { transport: string; lastSeenAt: number }>();
  const mismatchesLogged = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const onProbe = (payload: unknown) => {
    const probe = parseProbe(payload);
    if (!probe) return;
    peers.set(probe.instanceId, { transport: probe.transport, lastSeenAt: probe.ts });
    if (probe.transport !== transport && !mismatchesLogged.has(probe.instanceId)) {
      mismatchesLogged.add(probe.instanceId);
      // The payload crossed the adapter, so it is only as trustworthy as
      // Redis is: sanitised like every other externally-sourced log field.
      console.warn(
        `[fanout] instance ${sanitizeForLog(probe.instanceId)} reports transport ` +
          `"${sanitizeForLog(probe.transport)}" but this instance uses "${transport}"; ` +
          'cross-instance socket delivery is broken'
      );
    }
  };

  function emitProbe(): void {
    if (!probing) return;
    prunePeers(Date.now());
    try {
      const message: FanoutProbeMessage = { instanceId, transport, ts: Date.now() };
      namespace.serverSideEmit(FANOUT_PROBE_EVENT, message);
    } catch (error) {
      console.error(`[fanout] probe emit failed: ${describeError(error)}`);
    }
  }

  /**
   * Drop peers not heard from within the staleness window.
   *
   * Called from the probe timer as well as `getStatus`, because an instance
   * whose `INSTANCE_ID` is unset identifies itself by a fresh UUID on every
   * restart: leaving eviction to `/health` alone would let the map grow with
   * every peer restart on an instance nothing scrapes.
   */
  function prunePeers(now: number): void {
    for (const [peerId, peer] of peers) {
      if (now - peer.lastSeenAt > staleAfterMs) {
        peers.delete(peerId);
        // Retired peers must be able to warn again if they come back mixed.
        mismatchesLogged.delete(peerId);
      }
    }
  }

  function getStatus(now: number = Date.now()): FanoutStatus {
    prunePeers(now);
    let lastPeerEventAgeMs: number | null = null;
    let mixedTransport = false;
    const peersSeen: string[] = [];
    for (const [peerId, peer] of peers) {
      peersSeen.push(peerId);
      if (peer.transport !== transport) mixedTransport = true;
      const age = Math.max(now - peer.lastSeenAt, 0);
      if (lastPeerEventAgeMs === null || age < lastPeerEventAgeMs) {
        lastPeerEventAgeMs = age;
      }
    }
    peersSeen.sort();
    return {
      transport,
      probing,
      peersSeen,
      lastPeerEventAgeMs,
      // A single-process deployment is healthy by definition. A probing
      // instance that has heard from nobody is either alone in a fleet
      // provisioned for more, or unable to receive fan-out — both are worth
      // alerting on, and neither is distinguishable from here.
      healthy: !probing || (peersSeen.length > 0 && !mixedTransport),
      mixedTransport,
    };
  }

  if (probing) {
    namespace.on(FANOUT_PROBE_EVENT, onProbe);
    if (intervalMs > 0) {
      timer = setInterval(emitProbe, intervalMs);
      // The probe must never be the reason the process stays alive.
      timer.unref?.();
      // Announce this instance immediately so a peer that is already up does
      // not have to wait a full interval to see it.
      emitProbe();
    }
  }

  return {
    getStatus,
    emitProbe,
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (probing) namespace.off?.(FANOUT_PROBE_EVENT, onProbe);
    },
  };
}

export { createFanoutProbe, describeTransport, FANOUT_PROBE_EVENT };
export type { FanoutProbe, FanoutStatus };
