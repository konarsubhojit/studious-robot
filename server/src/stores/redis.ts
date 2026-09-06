import { randomUUID } from 'node:crypto';
import { STORE_NAMES } from './contracts.ts';
import { createRedisMessageBus } from '../messageBus.ts';
import { SHARED_SESSION_MAX_TTL_MS } from '../config.ts';

type SocketIoAdapterFactory = (
  pub: unknown,
  sub: unknown
) => Parameters<import('socket.io').Server['adapter']>[0];

function createHotMaps(): Record<string, Map<unknown, unknown>> {
  const maps: Record<string, Map<unknown, unknown>> = {};
  for (const name of STORE_NAMES) {
    maps[name] = new Map();
  }
  return maps;
}

function callKey(callId: string): string {
  return `signaling:call:${callId}`;
}

function sessionKey(sessionId: string): string {
  return `signaling:session:${sessionId}`;
}

const SWEEP_LEASE_KEY = 'signaling:calls:sweep:lease';

const TRANSITION_CALL_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ ok = false, error = 'not_found' }) end
local call = cjson.decode(raw)
local fromStatus = ARGV[1]
local toStatus = ARGV[2]
local nowIso = ARGV[3]
local reason = ARGV[4]
local terminal = { ended = true, declined = true, missed = true, busy = true, unreachable = true }
if call.status == toStatus then return cjson.encode({ ok = true, idempotent = true, call = call }) end
if terminal[call.status] then return cjson.encode({ ok = false, error = 'terminal_state' }) end
if call.status ~= fromStatus then return cjson.encode({ ok = false, error = 'stale_call_state' }) end
call.status = toStatus
call.updatedAt = nowIso
if reason ~= '' then call.endReason = reason end
redis.call('SET', KEYS[1], cjson.encode(call))
return cjson.encode({ ok = true, idempotent = false, call = call })
`;

const ACQUIRE_SWEEP_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 end
return 0
`;

const RELEASE_SWEEP_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function createRedisPgStores(
  opts: { redisUrl?: string; createClient?: () => any; createAdapter?: SocketIoAdapterFactory } = {}
): Promise<
  import('./contracts.ts').Stores & {
    messageBus: import('../messageBus.ts').MessageBus;
    attachAdapter: (io: import('socket.io').Server) => void;
    close: () => Promise<void>;
  }
> {
  const url = opts.redisUrl || process.env.REDIS_URL;
  if (!url && !opts.createClient) {
    throw new Error('createRedisPgStores: set REDIS_URL or pass opts.createClient');
  }

  const createClient =
    opts.createClient || ((await import('redis')).createClient.bind(null, { url }));
  const createAdapter =
    opts.createAdapter || (await import('@socket.io/redis-adapter')).createAdapter;

  const clients: any[] = [];
  async function openClient(): Promise<any> {
    const client = createClient();
    client.on?.('error', (error: any) => {
      console.error(`[stores:redis] client error: ${error?.message}`);
    });
    await client.connect?.();
    clients.push(client);
    return client;
  }

  const busPub = await openClient();
  const busSub = await openClient();
  const adapterPub = await openClient();
  const adapterSub = await openClient();

  const messageBus = createRedisMessageBus({ pub: busPub, sub: busSub });
  const instanceId = process.env.INSTANCE_ID || randomUUID();
  const callFallback = new Map<string, import('./contracts.ts').CallRecord>();
  const sessionFallback = new Map<string, import('./contracts.ts').SessionRecord>();
  const evalFn = typeof busPub.eval === 'function' ? busPub.eval.bind(busPub) : null;

  const bundle: Record<string, any> = createHotMaps();
  bundle.messageBus = messageBus;
  bundle.stateAffinity = 'shared';
  bundle.instanceId = instanceId;

  bundle.callState = {
    get: async (callId: string) => {
      if (typeof busPub.get === 'function') {
        const raw = await busPub.get(callKey(callId));
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return callFallback.get(callId) ?? null;
    },
    save: async (call: import('./contracts.ts').CallRecord) => {
      if (typeof busPub.set === 'function') {
        await busPub.set(callKey(call.callId), JSON.stringify(call));
        return;
      }
      callFallback.set(call.callId, { ...call });
    },
    transitionAtomic: async ({
      callId,
      fromStatus,
      toStatus,
      reason = null,
    }: {
      callId: string;
      fromStatus: string;
      toStatus: string;
      actor?: string | null;
      reason?: string | null;
    }) => {
      const redisResult = evalFn
        ? await evalFn(TRANSITION_CALL_LUA, {
            keys: [callKey(callId)],
            arguments: [fromStatus, toStatus, new Date().toISOString(), reason ?? ''],
          })
        : null;
      const resolved = evalFn
        ? (typeof redisResult === 'string' ? JSON.parse(redisResult) : redisResult)
        : (() => {
            const call = callFallback.get(callId);
            if (!call) return { ok: false, error: 'not_found' };
            const terminal = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);
            if (call.status === toStatus) return { ok: true, idempotent: true, call };
            if (terminal.has(call.status)) return { ok: false, error: 'terminal_state' };
            if (call.status !== fromStatus) return { ok: false, error: 'stale_call_state' };
            callFallback.set(callId, { ...call, status: toStatus, updatedAt: new Date().toISOString() });
            return { ok: true, idempotent: false, call: callFallback.get(callId) };
          })();
      if (!resolved?.ok) {
        return {
          ok: false as const,
          error: (resolved?.error ?? 'stale_call_state') as
            | 'not_found'
            | 'stale_call_state'
            | 'terminal_state',
        };
      }
      return {
        ok: true as const,
        call: resolved.call as import('./contracts.ts').CallRecord,
        idempotent: Boolean(resolved.idempotent),
      };
    },
    acquireSweepLease: async (ownerId: string, ttlMs: number) => {
      if (evalFn) {
        const result = await evalFn(ACQUIRE_SWEEP_LEASE_LUA, {
          keys: [SWEEP_LEASE_KEY],
          arguments: [ownerId, String(Math.max(1_000, ttlMs))],
        });
        return Number(result) === 1;
      }
      return true;
    },
    releaseSweepLease: async (ownerId: string) => {
      if (!evalFn) return;
      await evalFn(RELEASE_SWEEP_LEASE_LUA, {
        keys: [SWEEP_LEASE_KEY],
        arguments: [ownerId],
      });
    },
  };

  bundle.sessionState = {
    get: async (sessionId: string) => {
      if (typeof busPub.get === 'function') {
        const raw = await busPub.get(sessionKey(sessionId));
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return sessionFallback.get(sessionId) ?? null;
    },
    save: async (session: import('./contracts.ts').SessionRecord) => {
      const payload = JSON.stringify(session);
      const declared = session.expiresAt ? Date.parse(session.expiresAt) - Date.now() : Number.NaN;
      // Every session key is written with an expiry, without exception. A key
      // written without `PX` outlives the process that created it forever, so
      // a deployment with `SESSION_TTL_MS=0` used to leak one immortal key per
      // login. Where the session declares no expiry, the keyspace is still
      // bounded by SHARED_SESSION_MAX_TTL_MS; an already-expired session is
      // clamped to the shortest expiry Redis accepts rather than written
      // without one.
      const ttlMs = Number.isFinite(declared)
        ? Math.min(Math.max(declared, 1), SHARED_SESSION_MAX_TTL_MS)
        : SHARED_SESSION_MAX_TTL_MS;
      if (typeof busPub.set === 'function') {
        await busPub.set(sessionKey(session.sessionId), payload, { PX: ttlMs });
        return;
      }
      sessionFallback.set(session.sessionId, { ...session });
    },
    remove: async (sessionId: string) => {
      if (typeof busPub.del === 'function') {
        await busPub.del(sessionKey(sessionId));
        return;
      }
      sessionFallback.delete(sessionId);
    },
  };

  bundle.attachAdapter = (io: import('socket.io').Server) => {
    io.adapter(createAdapter(adapterPub, adapterSub));
  };

  bundle.close = async (): Promise<void> => {
    await bundle.callState?.releaseSweepLease(bundle.instanceId);
    await messageBus.close();
    await Promise.allSettled(clients.map((client) => client.quit?.()));
  };

  return bundle as any;
}

export { createRedisPgStores };
