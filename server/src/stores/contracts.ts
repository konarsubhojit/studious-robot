export type RoomStore = Map<string, Set<string>>;
export type UserStore = Map<string, import('../identity.ts').User>;
export type SessionRecord = { sessionId: string; userId: string; deviceId: string; platform: string | null; createdAt: string; expiresAt: string | null; };
export type SessionStore = Map<string, SessionRecord>;
export type UserSessionStore = Map<string, Set<string>>;
export type DeviceRecord = { deviceId: string; userId: string; platform: string | null; sessionId: string | null; pushProvider: string | null; pushToken: string | null; lastRegisteredAt?: string | null; lastUnregisteredAt?: string | null; updatedAt?: string | null; };
export type DeviceStore = Map<string, DeviceRecord>;
export type UserDeviceStore = Map<string, Set<string>>;
export type ConnectionRecord = { userId: string; socketId: string; deviceId: string; sessionId: string | null; connectedAt?: string; };
export type UserConnectionStore = Map<string, Map<string, ConnectionRecord>>;
export type PresenceRecord = { lastSeen: string | null; };
export type UserPresenceStore = Map<string, PresenceRecord>;
export type CallRecord = { callId: string; callerId: string; calleeId: string; status: string; endReason?: string | null; durationSeconds?: number | null; createdAt: string; updatedAt?: string | null; missedReadAt?: string | null; ringTimeoutAt?: string | null; answeredAt?: string | null; lastHeartbeatAt?: string | null; };
export type CallStore = Map<string, CallRecord>;
export type CallEvent = { eventId: string; callId: string; event: string; actor?: string | null; reason?: string | null; timestamp: string; };
export type CallEventStore = Map<string, CallEvent[]>;
export type MessageRecord = { messageId: string; conversationId: string; senderId: string; recipientId: string; body: string; type?: string; attachment?: object | null; replyTo?: string | null; reactions?: Record<string, string[]>; deletedAt?: string | null; createdAt: string; deliveredTo?: string[]; readAt?: string | null; };
export type BlockStore = Map<string, Set<string>>;
export type Stores = { rooms: RoomStore; users: UserStore; sessions: SessionStore; userSessions: UserSessionStore; devices: DeviceStore; userDevices: UserDeviceStore; userConnections: UserConnectionStore; userPresence: UserPresenceStore; calls: CallStore; callEvents: CallEventStore; blocks: BlockStore; messageBus?: import('../messageBus.ts').MessageBus | null; attachAdapter?: (io: any) => void; close?: () => Promise<void>; };
export type IncomingCallPushEntry = { acknowledgedDeviceIds: Set<string>; pushedDeviceIds: Set<string>; ackTimeouts: Map<string, NodeJS.Timeout>; };
export type AuditLog = { record: (entry: { event: string, actor?: string|null, target?: string|null, outcome: string, details?: object, }) => void; getForUser: (userId: string) => object[]; };
export type RateLimiter = { check: (key: string, now?: number) => { allowed: boolean, remaining: number, resetAt: number, }; };
export type ServerState = Stores & { db: any; auditLog: AuditLog; callInitRateLimiter: RateLimiter; rtcRateLimiter: RateLimiter; turnCredentialsRateLimiter: RateLimiter; messageSendRateLimiter: RateLimiter; messageSearchRateLimiter: RateLimiter; telemetry: import('../telemetry.ts').Telemetry; messageStore: any; cache: any; messageStoreStatus: string; messageBus: any; draining: boolean; incomingCallPushState?: Map<string, IncomingCallPushEntry>; };

/**
 * Names of every store in a {@link Stores} bundle.  Implementations must
 * provide a value for each of these keys.
 *
 * @type {readonly (keyof Stores)[]}
 */
const STORE_NAMES: readonly (keyof Stores)[] = Object.freeze([
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

export { STORE_NAMES };
