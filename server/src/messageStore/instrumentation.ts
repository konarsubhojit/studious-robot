/**
 * Query-timing instrumentation for a Mongo-backed store.
 *
 * Wrapping the *store methods* rather than the driver keeps the labels
 * business-meaningful: `listConversations` (a cross-partition fan-out) is
 * distinguishable from a point lookup, and a method that issues two round trips
 * (`saveMessage`'s upsert plus its replay `findOne`) reports the total cost the
 * caller actually paid.
 */

import { timeQuery } from '../lib/queryTiming.ts';
import type { MessageStore } from './types.ts';

/**
 * Which store methods read and which mutate, used to label their timings so
 * `/metrics` can separate read cost from write cost.
 */
const MONGO_OPERATION_KINDS: Record<string, 'read' | 'write'> = {
  saveMessage: 'write',
  listMessages: 'read',
  searchMessages: 'read',
  markDelivered: 'write',
  listConversations: 'read',
  markRead: 'write',
  deleteMessage: 'write',
  reactToMessage: 'write',
};

/**
 * Wrap every query-issuing method of a Mongo store so its duration is measured
 * and reported (see `lib/queryTiming.ts`).
 *
 * `ensureReady` is awaited *before* the timer starts so the one-time connect
 * and index creation — seconds, on a throttled Cosmos endpoint — never lands in
 * the latency of whichever query happened to be first.
 */
export function instrumentMongoStore(
  store: MessageStore,
  { collection, ensureReady }: { collection: string; ensureReady: () => Promise<unknown>; }
): MessageStore {
  const instrumented = (store as unknown) as Record<string, any>;
  for (const [operation, kind] of Object.entries(MONGO_OPERATION_KINDS)) {
    const original = instrumented[operation];
    if (typeof original !== 'function') continue;
    instrumented[operation] = async function timedOperation(...args: unknown[]) {
      await ensureReady();
      return timeQuery({ backend: 'mongo', operation, kind, target: collection }, () =>
        original.apply(store, args)
      );
    };
  }
  return store;
}
