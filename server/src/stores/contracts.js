// @ts-check
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
 * @typedef {Map<string, import('../identity').User>} UserStore
 *   userId → claimed-identity record.
 *
 * @typedef {object} SessionRecord
 *   A logged-in session, created by `POST /session` and looked up on every
 *   authenticated request and socket handshake.
 * @property {string} sessionId
 * @property {string} userId
 * @property {string} deviceId
 * @property {string|null} [platform]
 * @property {string} [createdAt]     ISO timestamp.
 * @property {string|null} [expiresAt] ISO timestamp; `null` when the session never expires.
 *
 * @typedef {Map<string, SessionRecord>} SessionStore
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
 * @typedef {Map<string, import('../domain/calls').CallRecord>} CallStore
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
 * The mutable server state object built by `createServer()` and threaded
 * through every HTTP route, socket handler and domain module.
 *
 * It is the {@link Stores} bundle plus the process-wide services those
 * handlers depend on (audit log, telemetry, rate limiters, message store,
 * cache) and a couple of lifecycle flags.  Declaring the shape once here
 * means a handler that reads `state.<something>` is checked against what
 * `createServer` actually provides.
 *
 * @typedef {Stores & {
 *   db: object|null,
 *   auditLog: import('../security').AuditLog,
 *   callInitRateLimiter: import('../security').RateLimiter,
 *   rtcRateLimiter: import('../security').RateLimiter,
 *   turnCredentialsRateLimiter: import('../security').RateLimiter,
 *   messageSendRateLimiter: import('../security').RateLimiter,
 *   messageSearchRateLimiter: import('../security').RateLimiter,
 *   telemetry: import('../telemetry').Telemetry,
 *   messageStore: any,
 *   cache: any,
 *   messageStoreStatus: string,
 *   messageBus: import('../messageBus').MessageBus|null,
 *   draining: boolean,
 *   incomingCallPushState?: Map<string, object>,
 * }} ServerState
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
