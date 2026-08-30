import { addBlock } from '../security.ts';
import { hydrateCallsAndEventsFromDb } from '../callPersistence.ts';
import { users as usersTable } from '../../db/schema.ts';
import { devices as devicesTable } from '../../db/schema.ts';
import { and, eq, ne } from 'drizzle-orm';
import { removeDevice, deviceFreshnessTimestamp, isDeviceInActiveUse } from './state.ts';
import { blocks as blocksTable } from '../../db/schema.ts';

/**
 * Durable (Postgres/Neon) persistence for identities, devices and blocks, plus
 * cold-start hydration of the in-memory state.
 *
 * Every write is best-effort: when `db` is null (tests / no `DATABASE_URL`) the
 * helpers are no-ops, and DB failures are logged rather than thrown so a
 * transient database issue never breaks a live request.
 */

/**
 * Drizzle database handle, bound to this project's schema (see
 * `db/client.ts`).  Aliased here because every persistence helper below takes
 * one, each accepting `null` for "no durable database configured".
 */
export type DrizzleDb = import('../../db/client.ts').Database;
export type Stores = import('../stores/contracts.ts').Stores;
export type DeviceRecord = import('../stores/contracts.ts').DeviceRecord;

/**
 * Persist a newly claimed identity so verification survives restarts.
 */
async function persistUser(db: DrizzleDb | null, user: import('../identity.ts').User): Promise<void> {
  if (!db || !user) return;
  try {
    await db
      .insert(usersTable)
      .values({
        userId: user.userId,
        authUid: user.authUid,
        email: user.email,
        authProvider: user.authProvider,
        createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
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
    console.error('[session] failed to persist user to DB:', ((err as any))?.message);
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
 */
async function persistDevice(db: DrizzleDb | null, device: DeviceRecord, action: 'registration' | 'unregistration' | 'session' = 'registration'): Promise<void> {
  if (!db || !device) return;
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
  const set: Record<string, unknown> = {
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
    console.error(`[devices] failed to persist device ${action} to DB:`, ((err as any))?.message);
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
 * @param reason - e.g. `'UNREGISTERED'` or `'INVALID_ARGUMENT'`.
 */
async function pruneDeadDevice(db: DrizzleDb | null, state: Stores, deviceId: string, reason: string): Promise<void> {
  const removed = removeDevice(state, deviceId);
  if (!removed) return;

  await deleteDeviceRow(db, deviceId);

  console.log(`[push] Pruned unregistered token device=${deviceId} reason=${reason}`);
}

/**
 * Best-effort delete of a device row from the DB.  Never throws: the in-memory
 * removal has already happened and a transient DB failure must not surface to
 * the caller.
 */
async function deleteDeviceRow(db: DrizzleDb | null, deviceId: string): Promise<void> {
  if (!db) return;
  try {
    await db.delete(devicesTable).where(eq(devicesTable.deviceId, deviceId));
  } catch (err) {
    console.error(`[push] failed to prune device ${deviceId} from DB:`, ((err as any))?.message);
  }
}

/**
 * Sweep device rows whose push registration has not been refreshed within
 * `maxAgeMs`, independent of any delivery feedback.
 *
 * `pruneDeadDevice` only fires when a provider reports a dead token, which the
 * Azure Notification Hubs delivery path never surfaces synchronously — a `201`
 * means the hub queued the notification, not that FCM accepted the token. So
 * rows orphaned by an app reinstall (which wipes the client-persisted
 * `device_id` and registers a brand-new row) would otherwise live forever and
 * take a push for every message.
 *
 * The app re-registers its token on every launch, so a row untouched for the
 * whole window belongs to an install that no longer exists.  A row backing a
 * live socket or an unexpired session is never swept, however old it looks, and
 * neither is a row that is merely unregistered but recent.
 *
 * @returns the number of device rows removed.
 */
async function pruneStaleDevices(db: DrizzleDb | null, state: Stores, { maxAgeMs, now = Date.now() }: { maxAgeMs: number; now?: number; }): Promise<number> {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;

  const cutoff = now - maxAgeMs;
  const stale: Array<{ deviceId: string; ageMs: number; }> = [];

  for (const device of state.devices.values()) {
    const timestamp = deviceFreshnessTimestamp(device);
    const lastSeen = timestamp ? Date.parse(timestamp) : NaN;
    // An unparseable/absent timestamp says nothing about the row's age, so
    // leave it alone rather than guess.
    if (Number.isNaN(lastSeen) || lastSeen > cutoff) continue;
    if (isDeviceInActiveUse(state, device)) continue;
    stale.push({ deviceId: device.deviceId, ageMs: now - lastSeen });
  }

  let pruned = 0;
  for (const { deviceId, ageMs } of stale) {
    if (!removeDevice(state, deviceId)) continue;
    await deleteDeviceRow(db, deviceId);
    pruned += 1;
    console.log(
      `[devices] Pruned stale device=${deviceId}` +
        ` ageDays=${Math.floor(ageMs / 86_400_000)} reason=registration_expired`
    );
  }

  return pruned;
}

/**
 * Persist a new block relationship.
 */
async function persistBlock(db: DrizzleDb | null, blockerId: string, blockeeId: string): Promise<void> {
  if (!db) return;
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
    console.error('[blocks] failed to persist block to DB:', ((error as any))?.message);
  }
}

/**
 * Remove a persisted block relationship.
 */
async function deletePersistedBlock(db: DrizzleDb | null, blockerId: string, blockeeId: string): Promise<void> {
  if (!db) return;
  try {
    await db
      .delete(blocksTable)
      .where(and(eq(blocksTable.blockerId, blockerId), eq(blocksTable.blockeeId, blockeeId)));
  } catch (error) {
    console.error('[blocks] failed to persist unblock to DB:', ((error as any))?.message);
  }
}

/**
 * Normalise a timestamp column to an ISO string.
 *
 * Drizzle hands back `Date` objects for timestamp columns, but a raw driver row
 * (or a stubbed db in tests) may yield a string or nothing at all.
 */
function toIsoString(value: Date | string | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

/**
 * Run a single hydration step, logging the outcome.  Failures are swallowed so
 * a partial DB outage can never prevent the server from starting.
 *
 * @param label singular record name used in the log lines
 * @param hydrate resolves to the number of rows read
 * @param opts when `required`, rethrow the failure
 */
async function runHydrationStep(label: string, hydrate: () => Promise<number>, { required = false }: { required?: boolean; } = {}): Promise<void> {
  try {
    const count = await hydrate();
    console.log(`[signaling] hydrated ${count} ${label} record(s) from DB`);
  } catch (err) {
    const message = `[signaling] failed to hydrate ${label}s from DB: ${((err as any))?.message}`;
    console.error(message);
    if (required) {
      throw new Error(message);
    }
  }
}

/**
 * Populate `state.users` with the claimed identities.
 *
 * @returns number of rows read
 */
async function hydrateUsers(db: DrizzleDb, state: Stores, usersTable: any): Promise<number> {
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
 * @returns number of rows read
 */
async function hydrateDevices(db: DrizzleDb, state: Stores, devicesTable: any): Promise<number> {
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
    let deviceIds = state.userDevices.get(row.userId);
    if (!deviceIds) {
      deviceIds = new Set();
      state.userDevices.set(row.userId, deviceIds);
    }
    deviceIds.add(row.deviceId);
  }
  return rows.length;
}

/**
 * Populate `state.blocks` with the persisted block relationships.
 *
 * @returns number of rows read
 */
async function hydrateBlocks(db: DrizzleDb, state: Stores, blocksTable: any): Promise<number> {
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
 */
async function loadPersistedStateFromDb(db: DrizzleDb | null, state: Stores): Promise<void> {
  if (!db) return;

  await runHydrationStep('user', () => hydrateUsers(db, state, usersTable), { required: true });
  await runHydrationStep('device', () => hydrateDevices(db, state, devicesTable));
  await hydrateCallsAndEventsFromDb(db, state);
  await runHydrationStep('block', () => hydrateBlocks(db, state, blocksTable));
}

export {
  persistUser,
  persistDevice,
  pruneDeadDevice,
  pruneStaleDevices,
  persistBlock,
  deletePersistedBlock,
  loadPersistedStateFromDb,
};
