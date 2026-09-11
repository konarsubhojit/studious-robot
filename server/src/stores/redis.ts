import { randomUUID } from 'node:crypto';
import { STORE_NAMES } from './contracts.ts';
import { createRedisMessageBus } from '../messageBus.ts';
import { isRedisPermissionError, reportRedisPermissionFailure } from '../lib/redisHealth.ts';
import {
  SHARED_SESSION_MAX_TTL_MS,
  SHARED_CALL_MAX_TTL_MS,
  TERMINAL_CALL_STATES,
} from '../config.ts';

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

function userCallsKey(userId: string): string {
  return `signaling:user:${userId}:calls`;
}

function sessionKey(sessionId: string): string {
  return `signaling:session:${sessionId}`;
}

/**
 * Write the record and reconcile both participants' active-call indexes in one
 * round trip, so a `busy` verdict on any instance can be answered per *user*
 * rather than per known callId.
 *
 * A non-terminal call is added to each participant's set; a terminal one is
 * removed. Both the record and the sets carry an expiry, so a crash between the
 * two writes cannot strand a member that blocks the user's calls forever.
 */
const SAVE_CALL_LUA = `
local ttl = tonumber(ARGV[2])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
if ARGV[3] == '1' then
  redis.call('SREM', KEYS[2], ARGV[4])
  redis.call('SREM', KEYS[3], ARGV[4])
else
  redis.call('SADD', KEYS[2], ARGV[4])
  redis.call('SADD', KEYS[3], ARGV[4])
  redis.call('PEXPIRE', KEYS[2], ttl)
  redis.call('PEXPIRE', KEYS[3], ttl)
end
return 1
`;

/**
 * Resolve a user's index to the records it names, dropping members whose record
 * has expired or has since become terminal.
 *
 * The index is a cache of `signaling:call:*`, never an authority: every answer
 * is read back from the records themselves, so a leaked member can only cost
 * one extra `GET` before it is swept out of the set.
 */
const LIST_USER_CALLS_LUA = `
local ids = redis.call('SMEMBERS', KEYS[1])
local out = {}
for _, id in ipairs(ids) do
  local raw = redis.call('GET', 'signaling:call:' .. id)
  if raw then
    local call = cjson.decode(raw)
    local terminal = { ended = true, declined = true, missed = true, busy = true, unreachable = true }
    if terminal[call.status] then
      redis.call('SREM', KEYS[1], id)
    else
      table.insert(out, raw)
    end
  else
    redis.call('SREM', KEYS[1], id)
  end
end
if #out == 0 then return '[]' end
return '[' .. table.concat(out, ',') .. ']'
`;

const TRANSITION_CALL_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ ok = false, error = 'not_found' }) end
local call = cjson.decode(raw)
local fromStatus = ARGV[1]
local toStatus = ARGV[2]
local nowIso = ARGV[3]
local reason = ARGV[4]
local ttl = tonumber(ARGV[5])
local terminal = { ended = true, declined = true, missed = true, busy = true, unreachable = true }
if call.status == toStatus then return cjson.encode({ ok = true, idempotent = true, call = call }) end
if terminal[call.status] then return cjson.encode({ ok = false, error = 'terminal_state' }) end
if call.status ~= fromStatus then return cjson.encode({ ok = false, error = 'stale_call_state' }) end
call.status = toStatus
call.updatedAt = nowIso
if reason ~= '' then call.endReason = reason end
redis.call('SET', KEYS[1], cjson.encode(call), 'PX', ttl)
if terminal[toStatus] then
  redis.call('SREM', KEYS[2], call.callId)
  redis.call('SREM', KEYS[3], call.callId)
end
return cjson.encode({ ok = true, idempotent = false, call = call })
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

  /**
   * What an operator must grant when Redis refuses a command outright.
   * Named in one place so every degraded-subsystem message says the same
   * thing.
   */
  const PERMISSION_REMEDY =
    'grant the signaling user both ACL axes, e.g. ' +
    '`ACL SETUSER <user> on >_<password> ~* &* +@all` (see docs/SETUP.md)';

  /**
   * Make the commands that no caller ever awaits survive a permission failure.
   *
   * `@socket.io/redis-adapter` subscribes (and publishes) fire-and-forget: it
   * never attaches a rejection handler, and `client.on('error')` does not cover
   * a rejected *command* promise. So a Valkey user without channel permissions
   * used to take the process down with an unhandled `SimpleError: NOPERM`,
   * which systemd turned into a fleet-wide restart loop — a misconfiguration
   * presenting as an outage.
   *
   * Only permission errors are absorbed, and each one is recorded so `/health`
   * reports the subsystem as degraded — including on the bus, whose callers
   * would otherwise log the same refusal once at boot and then look healthy
   * forever. Every other failure (an unreachable Redis above all) keeps
   * rejecting exactly as before, so the intentional fail-closed startup path in
   * `src/index.ts` is untouched.
   */
  function guardPermissionFailures(
    client: any,
    { scope, methods }: { scope: string; methods: string[] }
  ): any {
    const absorb = (error: unknown): undefined => {
      if (!isRedisPermissionError(error)) throw error;
      reportRedisPermissionFailure({ scope, error, remedy: PERMISSION_REMEDY });
      return undefined;
    };
    for (const method of methods) {
      const original = client?.[method];
      if (typeof original !== 'function') continue;
      client[method] = (...args: unknown[]) => {
        let result: any;
        try {
          result = original.apply(client, args);
        } catch (error) {
          return absorb(error);
        }
        return typeof result?.then === 'function'
          ? result.then(undefined, absorb)
          : result;
      };
    }
    return client;
  }

  async function openClient(guard?: { scope: string; methods: string[] }): Promise<any> {
    const client = createClient();
    client.on?.('error', (error: any) => {
      console.error(`[stores:redis] client error: ${error?.message}`);
    });
    await client.connect?.();
    if (guard) guardPermissionFailures(client, guard);
    clients.push(client);
    return client;
  }

  const SUBSCRIBE_METHODS = ['subscribe', 'pSubscribe', 'sSubscribe'];
  const busPub = await openClient();
  const busSub = await openClient({ scope: 'message-bus', methods: SUBSCRIBE_METHODS });
  const adapterPub = await openClient({ scope: 'fanout-adapter', methods: ['publish'] });
  const adapterSub = await openClient({ scope: 'fanout-adapter', methods: SUBSCRIBE_METHODS });

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
      if (evalFn) {
        await evalFn(SAVE_CALL_LUA, {
          keys: [callKey(call.callId), userCallsKey(call.callerId), userCallsKey(call.calleeId)],
          arguments: [
            JSON.stringify(call),
            String(SHARED_CALL_MAX_TTL_MS),
            TERMINAL_CALL_STATES.has(call.status) ? '1' : '0',
            call.callId,
          ],
        });
        return;
      }
      if (typeof busPub.set === 'function') {
        await busPub.set(callKey(call.callId), JSON.stringify(call), { PX: SHARED_CALL_MAX_TTL_MS });
        return;
      }
      callFallback.set(call.callId, { ...call });
    },
    listActiveCallsForUser: async (userId: string) => {
      if (evalFn) {
        const raw = await evalFn(LIST_USER_CALLS_LUA, { keys: [userCallsKey(userId)] });
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? (parsed as import('./contracts.ts').CallRecord[]) : [];
      }
      return Array.from(callFallback.values()).filter(
        (call) =>
          !TERMINAL_CALL_STATES.has(call.status) &&
          (call.callerId === userId || call.calleeId === userId)
      );
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
      // The index keys are resolved from the record this instance last read, so
      // a transition into a terminal state can clear both participants' index
      // members in the same atomic script that writes the record.
      const known = callFallback.get(callId) ?? (await bundle.callState.get(callId));
      const redisResult = evalFn
        ? await evalFn(TRANSITION_CALL_LUA, {
            keys: [
              callKey(callId),
              userCallsKey(known?.callerId ?? callId),
              userCallsKey(known?.calleeId ?? callId),
            ],
            arguments: [
              fromStatus,
              toStatus,
              new Date().toISOString(),
              reason ?? '',
              String(SHARED_CALL_MAX_TTL_MS),
            ],
          })
        : null;
      const resolved = evalFn
        ? (typeof redisResult === 'string' ? JSON.parse(redisResult) : redisResult)
        : (() => {
            const call = callFallback.get(callId);
            if (!call) return { ok: false, error: 'not_found' };
            if (call.status === toStatus) return { ok: true, idempotent: true, call };
            if (TERMINAL_CALL_STATES.has(call.status)) return { ok: false, error: 'terminal_state' };
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

  // Idempotent: the same promise is returned for every call so a second close
  // (from a caller that cannot know the first already ran) never issues
  // commands against clients that have already quit.
  let closePromise: Promise<void> | null = null;
  bundle.close = (): Promise<void> => {
    closePromise ??= (async () => {
      await messageBus.close();
      await Promise.allSettled(clients.map((client) => client.quit?.()));
    })();
    return closePromise;
  };

  return bundle as any;
}

export { createRedisPgStores };
