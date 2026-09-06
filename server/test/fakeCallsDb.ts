/**
 * A minimal Drizzle stand-in for the `calls` table.
 *
 * Shared by every suite that needs to exercise a durable call read path
 * offline (no `DATABASE_URL`): it stores the rows the server persists and
 * answers the queries those paths build against them.  It understands only
 * the shapes those queries actually use and throws on anything else, so a
 * query change can never silently degrade into "matches everything".
 */

import { randomUUID } from 'crypto';
import * as schema from '../db/schema.ts';
import { asDatabase } from './helpers.ts';

/** Map from a `calls` SQL column name to the property used on a row object. */
const CALL_COLUMN_TO_PROPERTY = new Map(
  Object.entries(schema.calls as unknown as Record<string, any>)
    .filter(([, column]) => typeof column?.name === 'string')
    .map(([property, column]) => [column.name as string, property])
);

/**
 * Compile a Drizzle condition (`and` / `or` of `eq`) into a row predicate.
 *
 * Only the shapes this read path builds are understood; anything else throws so
 * a query change can never silently degrade into "matches everything".
 */
type PredicateState = {
  children: Array<(row: any) => boolean>;
  operator: 'and' | 'or';
  column: string | null;
  comparator: 'eq' | 'lt';
};

/** Dates and ISO strings both order correctly once reduced to a number. */
function toComparable(value: unknown): number | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return typeof value === 'number' ? value : String(value ?? '');
}

function appendPredicateChunk(state: PredicateState, chunk: any) {
  if (Array.isArray(chunk?.value) && chunk.value.every((part: unknown) => typeof part === 'string')) {
    const text = chunk.value.join('').trim();
    if (text === 'and' || text === 'or') state.operator = text;
    // `isNull(col)` compiles to the column followed by the literal `is null`;
    // `lt(col, v)` to the column, `<`, then the bound value.
    else if (text === 'is null' && state.column !== null) {
      const property = state.column;
      state.children.push((row: any) => row[property] === null || row[property] === undefined);
      state.column = null;
    } else if (text === '<') state.comparator = 'lt';
    return;
  }
  if (chunk?.queryChunks) {
    state.children.push(compilePredicate(chunk));
    return;
  }
  if (typeof chunk?.name === 'string' && chunk?.table) {
    state.column = CALL_COLUMN_TO_PROPERTY.get(chunk.name) ?? chunk.name;
    return;
  }
  if (state.column !== null && chunk && 'value' in chunk) {
    const property = state.column;
    const expected = chunk.value;
    const compare = state.comparator;
    state.children.push(
      compare === 'lt'
        ? (row: any) => toComparable(row[property]) < toComparable(expected)
        : (row: any) => row[property] === expected,
    );
    state.column = null;
    state.comparator = 'eq';
    return;
  }
  throw new Error(`fake db: unsupported condition chunk ${JSON.stringify(chunk)}`);
}

function compilePredicate(node: any): (row: any) => boolean {
  const state: PredicateState = { children: [], operator: 'and', column: null, comparator: 'eq' };
  for (const chunk of node?.queryChunks ?? []) appendPredicateChunk(state, chunk);
  if (state.children.length === 0) return () => true;
  return (row: any) =>
    state.operator === 'and'
      ? state.children.every((predicate) => predicate(row))
      : state.children.some((predicate) => predicate(row));
}

/** @returns the row properties named by a list of `desc(column)` expressions. */
function orderProperties(expressions: any[]): string[] {
  const properties: string[] = [];
  for (const expression of expressions) {
    for (const chunk of expression?.queryChunks ?? []) {
      if (typeof chunk?.name === 'string' && chunk?.table) {
        properties.push(CALL_COLUMN_TO_PROPERTY.get(chunk.name) ?? chunk.name);
      }
    }
  }
  return properties;
}

/**
 * A minimal Drizzle stand-in that upserts `calls` rows and answers the
 * filtered, ordered, paged history query against them.
 */
export function createFakeCallsDb() {
  const rows = new Map<string, any>();

  /** Seed a call row directly, as if it had been persisted in an earlier run. */
  function seedCall(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    const row = {
      callId: randomUUID(),
      callerId: 'user-seed-caller',
      calleeId: 'user-seed-callee',
      status: 'ended',
      endReason: 'ended',
      durationSeconds: 0,
      missedReadAt: null,
      createdAt: now,
      updatedAt: now,
      ringTimeoutAt: null,
      ...overrides,
    };
    rows.set(row.callId, row);
    return row;
  }

  function select(selection?: Record<string, unknown>) {
    const isCount = Boolean(selection);
    return {
      from(table: any) {
        let predicate: (row: any) => boolean = () => true;
        let order: string[] = [];
        let limit = Infinity;
        let offset = 0;

        const resolve = () => {
          if (table !== schema.calls) return [];
          let matched = [...rows.values()].filter(predicate);
          if (isCount) return [{ value: matched.length }];
          for (const property of [...order].reverse()) {
            matched = [...matched].sort((a, b) => {
              const left = a[property] instanceof Date ? a[property].getTime() : a[property];
              const right = b[property] instanceof Date ? b[property].getTime() : b[property];
              if (left === right) return 0;
              return left < right ? 1 : -1; // descending
            });
          }
          return matched.slice(offset, offset + limit);
        };

        const builder: any = {
          where(condition: any) {
            predicate = compilePredicate(condition);
            return builder;
          },
          orderBy(...expressions: any[]) {
            order = orderProperties(expressions);
            return builder;
          },
          limit(value: number) {
            limit = value;
            return builder;
          },
          offset(value: number) {
            offset = value;
            return builder;
          },
          then(onFulfilled: any, onRejected: any) {
            return Promise.resolve(resolve()).then(onFulfilled, onRejected);
          },
        };
        return builder;
      },
    };
  }

  // The double implements only the slice of the Drizzle surface these tests
  // exercise; assert it once here rather than at every injection point.
  return asDatabase({
    rows,
    seedCall,
    select,
    insert(table: any) {
      return {
        values(values: any) {
          if (table === schema.calls) rows.set(values.callId, { ...values });
          const promise: any = Promise.resolve();
          promise.onConflictDoUpdate = ({ set }: { set: any; }) => {
            if (table === schema.calls) {
              rows.set(values.callId, { ...rows.get(values.callId), ...values, ...set });
            }
            return Promise.resolve();
          };
          promise.onConflictDoNothing = () => Promise.resolve();
          return promise;
        },
      };
    },
    update(table: any) {
      return {
        set(values: Record<string, unknown>) {
          let matched: any[] = [];
          const builder: any = {
            where(condition: any) {
              if (table !== schema.calls) return builder;
              const predicate = compilePredicate(condition);
              matched = [...rows.values()].filter(predicate);
              for (const row of matched) Object.assign(row, values);
              return builder;
            },
            returning(selection?: Record<string, any>) {
              const keys = Object.keys(selection ?? {});
              return Promise.resolve(
                matched.map((row) =>
                  keys.length === 0
                    ? { ...row }
                    : Object.fromEntries(keys.map((key) => [key, row[key]])),
                ),
              );
            },
            then(onFulfilled: any, onRejected: any) {
              return Promise.resolve(matched).then(onFulfilled, onRejected);
            },
          };
          return builder;
        },
      };
    },
    delete() {
      return { where: () => Promise.resolve() };
    },
  });
}
