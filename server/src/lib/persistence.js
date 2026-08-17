'use strict';

const { addBlock } = require('../security');
const { hydrateCallsAndEventsFromDb } = require('../callPersistence');

/**
 * Durable (Postgres/Neon) persistence for identities, devices and blocks, plus
 * cold-start hydration of the in-memory state.
 *
 * Every write is best-effort: when `db` is null (tests / no `DATABASE_URL`) the
 * helpers are no-ops, and DB failures are logged rather than thrown so a
 * transient database issue never breaks a live request.
 */

/**
 * Persist a newly claimed identity so verification survives restarts.
 *
 * @param {object|null} db
 * @param {object} user
 * @returns {Promise<void>}
 */
async function persistUser(db, user) {
  if (!db || !user) return;
  const { users: usersTable } = require('../../db/schema');
  try {
    await db
      .insert(usersTable)
      .values({
        userId: user.userId,
        authUid: user.authUid,
        email: user.email,
        authProvider: user.authProvider,
        createdAt: new Date(user.createdAt),
        verifiedAt: user.verifiedAt ? new Date(user.verifiedAt) : null,
      })
      .onConflictDoUpdate({
        target: usersTable.userId,
        set: {
          authUid: user.authUid,
          email: user.email,
          authProvider: user.authProvider,
          verifiedAt: user.verifiedAt ? new Date(user.verifiedAt) : null,
        },
      });
  } catch (err) {
    console.error('[session] failed to persist user to DB:', err?.message);
    throw err;
  }
}

/**
 * Persist a device registration so it survives restarts.
 *
 * The caller passes the already-upserted in-memory device record.
 *
 * `action` controls how the push columns are treated on conflict:
 *   - `'registration'`   – write provider/token (a device registered a token).
 *   - `'unregistration'` – clear provider/token (a device signed out).
 *   - `'session'`        – a device merely came online; the push columns are
 *     left untouched on an existing row so a session created before the push
 *     token is acquired (or while the DB hydration failed) can never wipe a
 *     previously registered token.
 *
 * @param {object|null} db
 * @param {object} device
 * @param {'registration'|'unregistration'|'session'} [action]
 * @returns {Promise<void>}
 */
async function persistDevice(db, device, action = 'registration') {
  if (!db || !device) return;
  const { devices: devicesTable } = require('../../db/schema');
  const values = {
    deviceId: device.deviceId,
    userId: device.userId,
    platform: device.platform ?? null,
    pushProvider: device.pushProvider ?? null,
    pushToken: device.pushToken ?? null,
    lastRegisteredAt: device.lastRegisteredAt ? new Date(device.lastRegisteredAt) : null,
    lastUnregisteredAt: device.lastUnregisteredAt ? new Date(device.lastUnregisteredAt) : null,
    updatedAt: new Date(),
  };
  const set = {
    userId: values.userId,
    platform: values.platform,
    updatedAt: values.updatedAt,
  };
  if (action !== 'session') {
    set.pushProvider = values.pushProvider;
    set.pushToken = values.pushToken;
    set.lastRegisteredAt = values.lastRegisteredAt;
    set.lastUnregisteredAt = values.lastUnregisteredAt;
  }
  try {
    if (action === 'registration' && values.pushToken) {
      // A live push token can only belong to one row (see the partial unique
      // index on `push_token` in db/schema.js). Evict it from any other
      // device first so this registration's upsert below never trips that
      // constraint, and so the previous holder — stale, or another user's row
      // if this physical device switched accounts — stops receiving pushes
      // meant for this token.
      const { and, eq, ne } = require('drizzle-orm');
      await db
        .update(devicesTable)
        .set({ pushProvider: null, pushToken: null, updatedAt: values.updatedAt })
        .where(
          and(
            eq(devicesTable.pushToken, values.pushToken),
            ne(devicesTable.deviceId, values.deviceId)
          )
        );
    }
    await db.insert(devicesTable).values(values).onConflictDoUpdate({
      target: devicesTable.deviceId,
      set,
    });
  } catch (err) {
    console.error(`[devices] failed to persist device ${action} to DB:`, err?.message);
  }
}

/**
 * Delete a device row after a push delivery attempt proves its token is dead
 * (FCM `UNREGISTERED` / `INVALID_ARGUMENT` — see `server/src/push.js`).
 *
 * Removes the row from both the in-memory state and (best-effort) the DB, and
 * logs the prune explicitly so a dead token is never again indistinguishable
 * from a successful delivery in the logs. Never logs the token itself.
 *
 * @param {object|null} db
 * @param {object} state
 * @param {string} deviceId
 * @param {string} reason - e.g. `'UNREGISTERED'` or `'INVALID_ARGUMENT'`.
 * @returns {Promise<void>}
 */
async function pruneDeadDevice(db, state, deviceId, reason) {
  const { removeDevice } = require('./state');
  const removed = removeDevice(state, deviceId);
  if (!removed) return;

  if (db) {
    try {
      const { eq } = require('drizzle-orm');
      const { devices: devicesTable } = require('../../db/schema');
      await db.delete(devicesTable).where(eq(devicesTable.deviceId, deviceId));
    } catch (err) {
      console.error(`[push] failed to prune device ${deviceId} from DB:`, err?.message);
    }
  }

  console.log(`[push] Pruned unregistered token device=${deviceId} reason=${reason}`);
}

/**
 * Persist a new block relationship.
 *
 * @param {object|null} db
 * @param {string} blockerId
 * @param {string} blockeeId
 * @returns {Promise<void>}
 */
async function persistBlock(db, blockerId, blockeeId) {
  if (!db) return;
  const { blocks: blocksTable } = require('../../db/schema');
  try {
    await db
      .insert(blocksTable)
      .values({
        blockerId,
        blockeeId,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error('[blocks] failed to persist block to DB:', error?.message);
  }
}

/**
 * Remove a persisted block relationship.
 *
 * @param {object|null} db
 * @param {string} blockerId
 * @param {string} blockeeId
 * @returns {Promise<void>}
 */
async function deletePersistedBlock(db, blockerId, blockeeId) {
  if (!db) return;
  try {
    const { and, eq } = require('drizzle-orm');
    const { blocks: blocksTable } = require('../../db/schema');
    await db
      .delete(blocksTable)
      .where(and(eq(blocksTable.blockerId, blockerId), eq(blocksTable.blockeeId, blockeeId)));
  } catch (error) {
    console.error('[blocks] failed to persist unblock to DB:', error?.message);
  }
}

/**
 * Normalise a timestamp column to an ISO string.
 *
 * Drizzle hands back `Date` objects for timestamp columns, but a raw driver row
 * (or a stubbed db in tests) may yield a string or nothing at all.
 *
 * @param {Date|string|null|undefined} value
 * @returns {string|null}
 */
function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

/**
 * Run a single hydration step, logging the outcome.  Failures are swallowed so
 * a partial DB outage can never prevent the server from starting.
 *
 * @param {string} label singular record name used in the log lines
 * @param {() => Promise<number>} hydrate resolves to the number of rows read
 * @returns {Promise<void>}
 */
async function runHydrationStep(label, hydrate, { required = false } = {}) {
  try {
    const count = await hydrate();
    console.log(`[signaling] hydrated ${count} ${label} record(s) from DB`);
  } catch (err) {
    const message = `[signaling] failed to hydrate ${label}s from DB: ${err?.message}`;
    console.error(message);
    if (required) {
      throw new Error(message);
    }
  }
}

/**
 * Populate `state.users` with the claimed identities.
 *
 * @returns {Promise<number>} number of rows read
 */
async function hydrateUsers(db, state, usersTable) {
  const rows = await db.select().from(usersTable);
  for (const row of rows) {
    state.users.set(row.userId, {
      userId: row.userId,
      authUid: row.authUid ?? null,
      email: row.email ?? null,
      authProvider: row.authProvider ?? null,
      createdAt: toIsoString(row.createdAt),
      verifiedAt: toIsoString(row.verifiedAt),
    });
  }
  return rows.length;
}

/**
 * Populate `state.devices` / `state.userDevices` with the device registrations.
 *
 * @returns {Promise<number>} number of rows read
 */
async function hydrateDevices(db, state, devicesTable) {
  const rows = await db.select().from(devicesTable);
  for (const row of rows) {
    if (!row?.deviceId || !row?.userId) continue;
    state.devices.set(row.deviceId, {
      deviceId: row.deviceId,
      userId: row.userId,
      platform: row.platform ?? null,
      sessionId: null,
      pushProvider: row.pushProvider ?? null,
      pushToken: row.pushToken ?? null,
      lastRegisteredAt: toIsoString(row.lastRegisteredAt),
      lastUnregisteredAt: toIsoString(row.lastUnregisteredAt),
      updatedAt: toIsoString(row.updatedAt),
    });
    if (!state.userDevices.has(row.userId)) {
      state.userDevices.set(row.userId, new Set());
    }
    state.userDevices.get(row.userId).add(row.deviceId);
  }
  return rows.length;
}

/**
 * Populate `state.blocks` with the persisted block relationships.
 *
 * @returns {Promise<number>} number of rows read
 */
async function hydrateBlocks(db, state, blocksTable) {
  const rows = await db.select().from(blocksTable);
  for (const row of rows) {
    if (!row?.blockerId || !row?.blockeeId) continue;
    addBlock(state.blocks, row.blockerId, row.blockeeId);
  }
  return rows.length;
}

/**
 * Hydrate the in-memory state from the Neon (Postgres) database.
 *
 * Reads persisted tables and populates corresponding in-memory caches so
 * identity verification, push delivery, call history/events, and block rules
 * work correctly after a cold start or rolling restart.
 *
 * This is a best-effort operation: failures are logged but do not prevent the
 * server from starting.  When `db` is null the function is a no-op (i.e. tests
 * and deployments without `DATABASE_URL` are unaffected).
 *
 * @param {import('drizzle-orm/node-postgres').NodePgDatabase|null} db
 * @param {object} state
 * @returns {Promise<void>}
 */
async function loadPersistedStateFromDb(db, state) {
  if (!db) return;

  const {
    users: usersTable,
    devices: devicesTable,
    blocks: blocksTable,
  } = require('../../db/schema');

  await runHydrationStep('user', () => hydrateUsers(db, state, usersTable), { required: true });
  await runHydrationStep('device', () => hydrateDevices(db, state, devicesTable));
  await hydrateCallsAndEventsFromDb(db, state);
  await runHydrationStep('block', () => hydrateBlocks(db, state, blocksTable));
}

module.exports = {
  persistUser,
  persistDevice,
  pruneDeadDevice,
  persistBlock,
  deletePersistedBlock,
  loadPersistedStateFromDb,
};
