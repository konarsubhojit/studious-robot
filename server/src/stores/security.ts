import { and, eq, or } from 'drizzle-orm';
import { blocks } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';
import type { SecurityTransport, SharedBlocks } from './contracts.ts';

export type SecurityCommandClient = {
  isReady?: boolean;
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
};

// The TTL and increment are a single operation; rejected attempts do not extend
// the window or consume additional allowance.
export const RATE_LIMIT_LUA = `
if tonumber(ARGV[1]) <= 0 then return {0, 0, tonumber(ARGV[2])} end
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count == 0 then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[2])
  return {1, tonumber(ARGV[1]) - 1, tonumber(ARGV[2])}
end
local ttl = redis.call('PTTL', KEYS[1])
if count >= tonumber(ARGV[1]) then return {0, 0, ttl} end
redis.call('INCR', KEYS[1])
return {1, tonumber(ARGV[1]) - count - 1, ttl}
`;

export function createRedisSecurity(client: SecurityCommandClient, timeoutMs = 250): SecurityTransport {
  let degraded = false;
  let lastWarning = -Infinity;
  let inFlight = 0;
  let retryAt = 0;
  const waiting = new Set<() => void>();

  async function acquire(signal: AbortSignal): Promise<void> {
    if (inFlight < 64) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        waiting.delete(start);
        reject(new Error('Redis security command timed out'));
      };
      const start = () => {
        signal.removeEventListener('abort', abort);
        inFlight += 1;
        resolve();
      };
      waiting.add(start);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  function release(): void {
    inFlight -= 1;
    const next = waiting.values().next().value;
    if (!next) return;
    waiting.delete(next);
    next();
  }

  function fail(): void {
    degraded = true;
    if (Date.now() - lastWarning < 60_000) return;
    lastWarning = Date.now();
    console.warn('[security] Redis rate limits degraded; using per-instance local limits');
  }

  async function check(namespace: string, identity: string, max: number, windowMs: number) {
    if (client.isReady === false || Date.now() < retryAt) {
      fail();
      throw new Error('Redis security client unavailable');
    }
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    try {
      const command = Promise.resolve().then(async () => {
        await acquire(controller.signal);
        try {
          if (controller.signal.aborted || client.isReady === false) throw new Error('Redis security client unavailable');
          return await client.eval(RATE_LIMIT_LUA, {
            keys: [`signaling:limit:${encodeKey(namespace)}:${encodeKey(identity)}`],
            arguments: [String(max), String(windowMs)],
          });
        } finally {
          release();
        }
      });
      const result = await Promise.race([
        command,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            retryAt = Date.now() + 1000;
            controller.abort();
            reject(new Error('Redis security command timed out'));
          }, timeoutMs);
        }),
      ]);
      if (!Array.isArray(result) || result.length !== 3) throw new Error('Invalid Redis limiter result');
      const [allowed, remaining, ttl] = result.map(Number);
      if (![0, 1].includes(allowed) || !Number.isFinite(remaining) || !Number.isFinite(ttl) || remaining < 0 || ttl < 0) {
        throw new Error('Invalid Redis limiter result');
      }
      degraded = false;
      retryAt = 0;
      return { allowed: allowed === 1, remaining, resetAt: Date.now() + ttl };
    } catch (error) {
      fail();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    check,
    getStatus: () => ({ transport: degraded || client.isReady === false ? 'local' : 'redis', degraded: degraded || client.isReady === false }),
  };
}

function encodeKey(value: string): string {
  // JSON preserves lone surrogates too, unlike a raw UTF-8 Buffer conversion.
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Postgres is the sole authority: startup snapshots never write back blocks. */
export function createPgSharedBlocks(db: Database): SharedBlocks {
  const pair = (blockerId: string, targetId: string) =>
    and(eq(blocks.blockerId, blockerId), eq(blocks.blockeeId, targetId));
  const either = (userId: string) => or(eq(blocks.blockerId, userId), eq(blocks.blockeeId, userId));
  return {
    async isBlocked(blockerId, targetId) {
      const rows = await db.select().from(blocks).where(pair(blockerId, targetId)).limit(1);
      return rows.length > 0;
    },
    async list(userId, bothDirections = false) {
      const rows = await db.select().from(blocks).where(bothDirections ? either(userId) : eq(blocks.blockerId, userId));
      return [...new Set(rows.map(row => row.blockerId === userId ? row.blockeeId : row.blockerId))];
    },
    async add(blockerId, targetId) {
      await db.insert(blocks).values({ blockerId, blockeeId: targetId }).onConflictDoNothing();
    },
    async remove(blockerId, targetId) {
      return (await db.delete(blocks).where(pair(blockerId, targetId)).returning()).length > 0;
    },
    async erase(userId) {
      return (await db.delete(blocks).where(either(userId)).returning()).length;
    },
  };
}
