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
        verificationHash: user.verificationHash,
        verificationSalt: user.verificationSalt,
        createdAt: new Date(user.createdAt),
        verifiedAt: user.verifiedAt ? new Date(user.verifiedAt) : null,
      })
      .onConflictDoUpdate({
        target: usersTable.userId,
        set: {
          verificationHash: user.verificationHash,
          verificationSalt: user.verificationSalt,
          verifiedAt: user.verifiedAt ? new Date(user.verifiedAt) : null,
        },
      });
  } catch (err) {
    console.error('[session] failed to persist user to DB:', err?.message);
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
    await db.insert(devicesTable).values(values).onConflictDoUpdate({
      target: devicesTable.deviceId,
      set,
    });
  } catch (err) {
    console.error(`[devices] failed to persist device ${action} to DB:`, err?.message);
  }
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

  // ── Hydrate claimed identities ──────────────────────────────────────────
  try {
    const rows = await db.select().from(usersTable);
    for (const row of rows) {
      state.users.set(row.userId, {
        userId: row.userId,
        verificationHash: row.verificationHash ?? null,
        verificationSalt: row.verificationSalt ?? null,
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? null),
        verifiedAt:
          row.verifiedAt instanceof Date ? row.verifiedAt.toISOString() : (row.verifiedAt ?? null),
      });
    }
    console.log(`[signaling] hydrated ${rows.length} user record(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate users from DB:', err?.message);
  }

  // ── Hydrate device registrations ─────────────────────────────────────────
  try {
    const rows = await db.select().from(devicesTable);
    for (const row of rows) {
      if (!row?.deviceId || !row?.userId) continue;
      const device = {
        deviceId: row.deviceId,
        userId: row.userId,
        platform: row.platform ?? null,
        sessionId: null,
        pushProvider: row.pushProvider ?? null,
        pushToken: row.pushToken ?? null,
        lastRegisteredAt:
          row.lastRegisteredAt instanceof Date
            ? row.lastRegisteredAt.toISOString()
            : (row.lastRegisteredAt ?? null),
        lastUnregisteredAt:
          row.lastUnregisteredAt instanceof Date
            ? row.lastUnregisteredAt.toISOString()
            : (row.lastUnregisteredAt ?? null),
      };
      state.devices.set(device.deviceId, device);
      if (!state.userDevices.has(device.userId)) {
        state.userDevices.set(device.userId, new Set());
      }
      state.userDevices.get(device.userId).add(device.deviceId);
    }
    console.log(`[signaling] hydrated ${rows.length} device record(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate devices from DB:', err?.message);
  }

  await hydrateCallsAndEventsFromDb(db, state);

  // ── Hydrate block relationships ────────────────────────────────────────────
  try {
    const rows = await db.select().from(blocksTable);
    for (const row of rows) {
      if (!row?.blockerId || !row?.blockeeId) continue;
      addBlock(state.blocks, row.blockerId, row.blockeeId);
    }
    console.log(`[signaling] hydrated ${rows.length} block record(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate blocks from DB:', err?.message);
  }
}

module.exports = {
  persistUser,
  persistDevice,
  persistBlock,
  deletePersistedBlock,
  loadPersistedStateFromDb,
};
