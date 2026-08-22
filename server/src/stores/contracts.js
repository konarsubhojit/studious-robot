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
 * Call record as written by the call state machine (`src/domain/calls.js`) and
 * read by the timeline/history layers.
 *
 * @typedef {{
 *   callId: string,
 *   callerId: string,
 *   calleeId: string,
 *   status: string,
 *   endReason?: string|null,
 *   durationSeconds?: number|null,
 *   createdAt: string,
 *   updatedAt?: string|null,
 *   missedReadAt?: string|null,
 *   ringTimeoutAt?: string|null,
 *   answeredAt?: string|null,
 *   lastHeartbeatAt?: string|null,
 * }} CallRecord
 *
 * @typedef {Map<string, CallRecord>} CallStore
 *   callId → call record.
 *
 * @typedef {{
 *   eventId: string,
 *   callId: string,
 *   event: string,
 *   actor?: string|null,
 *   reason?: string|null,
 *   timestamp: string,
 * }} CallEvent
 *
 * @typedef {Map<string, CallEvent[]>} CallEventStore
 *   callId → ordered list of call events.
 *
 * A persisted chat message document, as written by `src/messageStore.js`.
 *
 * @typedef {object} MessageRecord
 * @property {string} messageId
 * @property {string} conversationId
 * @property {string} senderId
 * @property {string} recipientId
 * @property {string} body
 * @property {string} [type]
 * @property {object|null} [attachment]
 * @property {string|null} [replyTo]
 * @property {Record<string, string[]>} [reactions]
 * @property {string|null} [deletedAt]
 * @property {string} createdAt
 * @property {string[]} [deliveredTo]
 * @property {string|null} [readAt]
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
 * @property {import('../messageBus').MessageBus|null} [messageBus]
 *   Cross-instance bus, present on the Redis-backed bundle only.
 * @property {(io: any) => void} [attachAdapter]
 *   Attaches the Socket.IO Redis adapter, present on the Redis bundle only.
 * @property {() => Promise<void>} [close]
 *   Releases backend connections, present on backends that hold any.
 *
 * Per-call bookkeeping for incoming-call push fan-out: which devices were
 * pushed, which acknowledged, and the pending ack-timeout timers.
 *
 * @typedef {object} IncomingCallPushEntry
 * @property {Set<string>} acknowledgedDeviceIds
 * @property {Set<string>} pushedDeviceIds
 * @property {Map<string, NodeJS.Timeout>} ackTimeouts
 *
 * @typedef {object} AuditLog
 * @property {(entry: {
 *   event: string,
 *   actor?: string|null,
 *   target?: string|null,
 *   outcome: string,
 *   details?: object,
 * }) => void} record
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
 *   telemetry: import('../telemetry').Telemetry,
 *   messageStore: any,
 *   cache: any,
 *   messageStoreStatus: string,
 *   messageBus: any,
 *   draining: boolean,
 *   incomingCallPushState?: Map<string, IncomingCallPushEntry>,
 * }} ServerState
 */

/**
 * Names of every store in a {@link Stores} bundle.  Implementations must
 * provide a value for each of these keys.
 *
 * @type {readonly (keyof Stores)[]}
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
