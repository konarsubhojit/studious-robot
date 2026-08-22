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
 *   userId → claimed-identity record (`{ userId, verificationHash, verificationSalt, … }`).
 *
 * @typedef {object} SessionRecord
 * @property {string} sessionId
 * @property {string} userId
 * @property {string} deviceId
 * @property {string|null} platform
 * @property {string} createdAt
 * @property {string|null} expiresAt  ISO expiry, or `null` when sessions never expire.
 *
 * @typedef {Map<string, SessionRecord>} SessionStore
 *   sessionId → session record.
 *
 * @typedef {Map<string, Set<string>>} UserSessionStore
 *   userId → set of sessionIds owned by the user.
 *
 * @typedef {object} DeviceRecord
 * @property {string} deviceId
 * @property {string} userId
 * @property {string|null} platform
 * @property {string|null} sessionId
 * @property {string|null} pushProvider
 * @property {string|null} pushToken
 * @property {string|null} [lastRegisteredAt]
 * @property {string|null} [lastUnregisteredAt]
 * @property {string|null} [updatedAt]
 *
 * @typedef {Map<string, DeviceRecord>} DeviceStore
 *   deviceId → device registration record.
 *
 * @typedef {Map<string, Set<string>>} UserDeviceStore
 *   userId → set of deviceIds registered to the user.
 *
 * @typedef {object} ConnectionRecord
 * @property {string} userId
 * @property {string} socketId
 * @property {string} deviceId
 * @property {string|null} sessionId
 * @property {string} [connectedAt]
 *
 * @typedef {Map<string, Map<string, ConnectionRecord>>} UserConnectionStore
 *   userId → (socketId → live connection record).
 *
 * @typedef {object} PresenceRecord
 * @property {string|null} lastSeen  ISO timestamp of the last disconnect, or `null` while online.
 *
 * @typedef {Map<string, PresenceRecord>} UserPresenceStore
 *   userId → presence record.
 *
 * Call record as read by the timeline/history layers. Extra fields written by
 * the call state machine are tolerated via the index signature until
 * `src/domain/calls.js` is migrated.
 *
 * @typedef {{
 *   callId: string,
 *   callerId: string,
 *   calleeId: string,
 *   status: string,
 *   endReason?: string|null,
 *   durationSeconds?: number|null,
 *   createdAt: string,
 *   missedReadAt?: string|null,
 *   [key: string]: any,
 * }} CallRecord
 *
 * @typedef {Map<string, CallRecord>} CallStore
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
 *
 * @typedef {object} AuditLog
 * @property {(entry: {
 *   event: string,
 *   actor?: string|null,
 *   target?: string|null,
 *   outcome?: string,
 *   details?: object,
 * }) => object} record
 * @property {(userId: string) => object[]} getForUser
 *
 * @typedef {object} RateLimiter
 * @property {(key: string, now?: number) => {
 *   allowed: boolean,
 *   remaining: number,
 *   resetAt: number,
 * }} check
 *
 * The mutable server state assembled by `createServer`: every store from the
 * bundle plus the shared services the handlers read.  Services that own a
 * module of their own are typed as that module migrates; the rest stay `any`
 * so a partially migrated handler is still checked against the store shapes.
 *
 * @typedef {Stores & {
 *   db: any,
 *   auditLog: AuditLog,
 *   callInitRateLimiter: RateLimiter,
 *   rtcRateLimiter: RateLimiter,
 *   turnCredentialsRateLimiter: RateLimiter,
 *   messageSendRateLimiter: RateLimiter,
 *   messageSearchRateLimiter: RateLimiter,
 *   telemetry: any,
 *   messageStore: any,
 *   cache: any,
 *   messageStoreStatus: string,
 *   messageBus: any,
 *   draining: boolean,
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
