'use strict';

/**
 * Store contracts.
 *
 * The signaling server keeps all of its mutable runtime state in a small set of
 * keyed collections (rooms, sessions, devices, calls, …).  Historically these
 * lived as bare `Map` instances on the server's `state` object, which made it
 * impossible to swap the backing storage for a durable/shared implementation
 * (Redis hot state, Neon Postgres history) without touching every call site.
 *
 * To enable horizontal scaling and persistence later, each collection is now
 * obtained from a {@link Stores} bundle produced by `createStores()`.  The
 * default in-memory implementation simply wraps `Map` instances, so every store
 * exposes the standard `Map` interface (`get`, `set`, `has`, `delete`,
 * `values`, `keys`, `entries`, `[Symbol.iterator]`, …).  A future Redis- or
 * Postgres-backed implementation only has to honour the same interface for the
 * operations the server actually uses.
 *
 * Keeping the contract documented here means the server code can depend on the
 * shape of a store without caring how it is implemented.
 *
 * @typedef {Map<string, Set<string>>} RoomStore
 *   roomId → set of socket ids currently in the room.
 *
 * @typedef {Map<string, object>} UserStore
 *   userId → claimed-identity record (`{ userId, verificationHash, verificationSalt, … }`).
 *
 * @typedef {Map<string, object>} SessionStore
 *   sessionId → session record.
 *
 * @typedef {Map<string, Set<string>>} UserSessionStore
 *   userId → set of sessionIds owned by the user.
 *
 * @typedef {Map<string, object>} DeviceStore
 *   deviceId → device registration record.
 *
 * @typedef {Map<string, Set<string>>} UserDeviceStore
 *   userId → set of deviceIds registered to the user.
 *
 * @typedef {Map<string, Map<string, object>>} UserConnectionStore
 *   userId → (socketId → live connection record).
 *
 * @typedef {Map<string, object>} UserPresenceStore
 *   userId → presence record (e.g. `{ lastSeen }`).
 *
 * @typedef {Map<string, object>} CallStore
 *   callId → call record.
 *
 * @typedef {Map<string, object[]>} CallEventStore
 *   callId → ordered list of call events.
 *
 * @typedef {Map<string, Set<string>>} BlockStore
 *   blockerId → set of blocked userIds.
 *
 * @typedef {object} Stores
 * @property {RoomStore} rooms
 * @property {UserStore} users
 * @property {SessionStore} sessions
 * @property {UserSessionStore} userSessions
 * @property {DeviceStore} devices
 * @property {UserDeviceStore} userDevices
 * @property {UserConnectionStore} userConnections
 * @property {UserPresenceStore} userPresence
 * @property {CallStore} calls
 * @property {CallEventStore} callEvents
 * @property {BlockStore} blocks
 */

/**
 * Names of every store in a {@link Stores} bundle.  Implementations must
 * provide a value for each of these keys.
 *
 * @type {readonly string[]}
 */
const STORE_NAMES = Object.freeze([
  'rooms',
  'users',
  'sessions',
  'userSessions',
  'devices',
  'userDevices',
  'userConnections',
  'userPresence',
  'calls',
  'callEvents',
  'blocks',
]);

module.exports = { STORE_NAMES };
