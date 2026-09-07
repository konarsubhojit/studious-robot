/**
 * Socket.IO fan-out transport selection.
 *
 * Cross-instance delivery of user-addressed events (`io.to(userRoom(id))`, see
 * `domain/notifications.ts`) needs an adapter that reaches sockets held by the
 * *other* signaling VM. Two implementations are supported:
 *
 *  | Transport        | Selected when                          | Who holds the socket |
 *  | ---------------- | -------------------------------------- | -------------------- |
 *  | `redis-adapter`  | default                                | this VM              |
 *  | `web-pubsub`     | `WEB_PUBSUB_CONNECTION_STRING` is set  | Azure Web PubSub     |
 *
 * This module is the *only* place that decides between them. The emit path is
 * deliberately not forked: both implementations keep the `io.to(room).emit()`
 * API, so `emitToUserSockets` and every `socket.emit(...)` call site are
 * unchanged and unaware of which transport is live.
 *
 * Redis stays load-bearing either way — it still backs the call registry,
 * sessions/presence and the read cache + invalidation bus (see
 * `deploy/README.md` §5a), so `REDIS_URL` remains mandatory for a
 * multi-instance deployment and the `lib/instances.ts` startup guard stays
 * armed regardless of the value of `WEB_PUBSUB_CONNECTION_STRING`.
 *
 * Failure policy follows the push provider chain in `push.ts`: a missing
 * dependency or a failed initialisation is logged loudly with a
 * `*_not_configured` / `*_init_failed` reason and degrades to the Redis path.
 * Nothing here throws at the caller — a signaling server that boots with the
 * previous transport is always better than one that does not boot.
 *
 * Env vars
 * ────────
 *   WEB_PUBSUB_CONNECTION_STRING  Web PubSub for Socket.IO connection string.
 *                                 Unset (the default) keeps the Redis adapter.
 *   WEB_PUBSUB_HUB                Hub name (default `signaling`).
 */

import { describeError } from './errors.ts';

/** Which fan-out transport is attached to the Socket.IO server. */
export type SocketTransport = 'redis-adapter' | 'web-pubsub';

/** Why the selected transport is what it is. */
export type SocketTransportReason =
  | 'web_pubsub_not_configured'
  | 'web_pubsub_dependency_missing'
  | 'web_pubsub_init_failed'
  | 'web_pubsub_attached';

/** Outcome of {@link attachSocketAdapter}. */
export type SocketAdapterResult = {
  transport: SocketTransport;
  reason: SocketTransportReason;
  /** Operator-facing detail for the failure reasons; empty otherwise. */
  detail: string;
};

/** Environment slice this module reads. */
export type SocketAdapterEnv = Record<string, string | undefined>;

/** Default hub name when `WEB_PUBSUB_HUB` is unset. */
export const DEFAULT_WEB_PUBSUB_HUB = 'signaling';

/**
 * The single call this module makes into `@azure/web-pubsub-socket.io`.
 * Injectable so tests never need the dependency (or a live Azure resource).
 */
export type UseAzureSocketIO = (
  io: import('socket.io').Server,
  options: { hub: string; connectionString: string }
) => unknown;

export type AttachSocketAdapterOptions = {
  io: import('socket.io').Server;
  /**
   * Attaches the Socket.IO Redis adapter. Supplied by the Redis-backed store
   * bundle (`stores.attachAdapter`); absent for a single-process, in-memory
   * deployment, in which case Socket.IO keeps its built-in adapter.
   */
  attachRedisAdapter?: ((io: import('socket.io').Server) => void) | null;
  env?: SocketAdapterEnv;
  /** Test seam for `useAzureSocketIO`; production resolves it by import. */
  useAzureSocketIO?: UseAzureSocketIO;
};

/** Read the configured Web PubSub connection string, if any. */
export function resolveWebPubSubConnectionString(
  env: SocketAdapterEnv = process.env
): string | null {
  const raw = env.WEB_PUBSUB_CONNECTION_STRING;
  if (!raw || raw.trim() === '') return null;
  return raw.trim();
}

/** Read the configured Web PubSub hub name. */
export function resolveWebPubSubHub(env: SocketAdapterEnv = process.env): string {
  const raw = env.WEB_PUBSUB_HUB;
  if (!raw || raw.trim() === '') return DEFAULT_WEB_PUBSUB_HUB;
  return raw.trim();
}

/**
 * Which transport the environment asks for, before any attempt to attach it.
 *
 * Selection is intentionally separate from attachment so it can be asserted
 * without a Socket.IO server: the *effective* transport is whatever
 * {@link attachSocketAdapter} reports, which may differ after a fallback.
 */
export function selectSocketTransport(env: SocketAdapterEnv = process.env): SocketTransport {
  return resolveWebPubSubConnectionString(env) ? 'web-pubsub' : 'redis-adapter';
}

/**
 * Resolve `useAzureSocketIO` from the optional dependency.
 *
 * The specifier is held in a variable so the module is never a static import:
 * an install without `@azure/web-pubsub-socket.io` (the default — it is not in
 * `package.json`) must degrade to Redis, not fail to load this file.
 */
async function loadUseAzureSocketIO(): Promise<UseAzureSocketIO> {
  const specifier = '@azure/web-pubsub-socket.io';
  const mod = (await import(specifier)) as Record<string, unknown>;
  const fn = mod.useAzureSocketIO;
  if (typeof fn !== 'function') {
    throw new Error('@azure/web-pubsub-socket.io does not export useAzureSocketIO');
  }
  return fn as UseAzureSocketIO;
}

function attachRedis(
  opts: AttachSocketAdapterOptions,
  reason: SocketTransportReason,
  detail: string
): SocketAdapterResult {
  if (typeof opts.attachRedisAdapter === 'function') {
    opts.attachRedisAdapter(opts.io);
    console.log('[signaling] Socket.IO Redis adapter attached (multi-instance mode)');
  }
  return { transport: 'redis-adapter', reason, detail };
}

/**
 * Attach the configured fan-out adapter to `io` and report which one is live.
 *
 * The Redis path runs synchronously, before this function's first `await`, so
 * the default deployment behaves exactly as it did when the adapter was
 * attached inline in the composition root.
 */
export async function attachSocketAdapter(
  opts: AttachSocketAdapterOptions
): Promise<SocketAdapterResult> {
  const env = opts.env ?? process.env;
  const connectionString = resolveWebPubSubConnectionString(env);
  if (!connectionString) {
    return attachRedis(opts, 'web_pubsub_not_configured', '');
  }

  const hub = resolveWebPubSubHub(env);
  let useAzureSocketIO = opts.useAzureSocketIO;
  if (!useAzureSocketIO) {
    try {
      useAzureSocketIO = await loadUseAzureSocketIO();
    } catch (error: unknown) {
      const detail = describeError(error);
      console.error(
        '[signaling] Web PubSub transport unavailable' +
          ` reason=web_pubsub_dependency_missing detail=${detail};` +
          ' falling back to the Socket.IO Redis adapter'
      );
      return attachRedis(opts, 'web_pubsub_dependency_missing', detail);
    }
  }

  try {
    await useAzureSocketIO(opts.io, { hub, connectionString });
  } catch (error: unknown) {
    const detail = describeError(error);
    console.error(
      '[signaling] Web PubSub transport failed to initialise' +
        ` reason=web_pubsub_init_failed hub=${hub} detail=${detail};` +
        ' falling back to the Socket.IO Redis adapter'
    );
    return attachRedis(opts, 'web_pubsub_init_failed', detail);
  }

  console.log(`[signaling] Socket.IO fan-out via Azure Web PubSub (hub=${hub})`);
  return { transport: 'web-pubsub', reason: 'web_pubsub_attached', detail: '' };
}
