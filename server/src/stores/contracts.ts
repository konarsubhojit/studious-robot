export type RoomStore = Map<string, Set<string>>;
export type UserStore = Map<string, import('../identity.ts').User>;
export type SessionRecord = {
  sessionId: string;
  userId: string;
  deviceId: string;
  platform: string | null;
  createdAt: string;
  expiresAt: string | null;
};
export type SessionStore = Map<string, SessionRecord>;
export type UserSessionStore = Map<string, Set<string>>;
export type DeviceRecord = {
  deviceId: string;
  userId: string;
  platform: string | null;
  sessionId: string | null;
  pushProvider: string | null;
  pushToken: string | null;
  lastRegisteredAt?: string | null;
  lastUnregisteredAt?: string | null;
  updatedAt?: string | null;
};
export type DeviceStore = Map<string, DeviceRecord>;
export type UserDeviceStore = Map<string, Set<string>>;
export type ConnectionRecord = {
  userId: string;
  socketId: string;
  deviceId: string;
  sessionId: string | null;
  connectedAt?: string;
};
export type UserConnectionStore = Map<string, Map<string, ConnectionRecord>>;
export type PresenceRecord = { lastSeen: string | null; };
export type UserPresenceStore = Map<string, PresenceRecord>;
export type CallRecord = {
  callId: string;
  callerId: string;
  calleeId: string;
  status: string;
  endReason?: string | null;
  durationSeconds?: number | null;
  createdAt: string;
  updatedAt?: string | null;
  missedReadAt?: string | null;
  ringTimeoutAt?: string | null;
  answeredAt?: string | null;
  lastHeartbeatAt?: string | null;
  /**
   * The device each participant is holding the call on: the one that placed it
   * and the one that answered it.
   *
   * Live routing state, not history — which is why neither is a column in the
   * `calls` table. A user may be signed in on several devices, and every
   * call-scoped decision that used to be made per *user* was wrong for all but
   * the simplest account: a second device could answer a call that was already
   * up, or report "I hold no calls" and have the server end the call running on
   * the first one.
   */
  callerDeviceId?: string | null;
  calleeDeviceId?: string | null;
};
export type CallStore = Map<string, CallRecord>;
export type CallEvent = {
  eventId: string;
  callId: string;
  event: string;
  actor?: string | null;
  reason?: string | null;
  timestamp: string;
};
export type CallEventStore = Map<string, CallEvent[]>;
export type MessageRecord = {
  messageId: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  body: string;
  type?: string;
  attachment?: object | null;
  replyTo?: string | null;
  reactions?: Record<string, string[]>;
  deletedAt?: string | null;
  createdAt: string;
  deliveredTo?: string[];
  readAt?: string | null;
};
export type BlockStore = Map<string, Set<string>>;
export type Stores = {
  rooms: RoomStore;
  users: UserStore;
  sessions: SessionStore;
  userSessions: UserSessionStore;
  devices: DeviceStore;
  userDevices: UserDeviceStore;
  userConnections: UserConnectionStore;
  userPresence: UserPresenceStore;
  calls: CallStore;
  callEvents: CallEventStore;
  blocks: BlockStore;
  messageBus?: import('../messageBus.ts').MessageBus | null;
  attachAdapter?: (io: import('socket.io').Server) => void;
  stateAffinity?: 'sticky' | 'shared';
  instanceId?: string;
  callState?: {
    get: (callId: string) => Promise<CallRecord | null>;
    save: (call: CallRecord) => Promise<void>;
    transitionAtomic: (args: {
      callId: string;
      fromStatus: string;
      toStatus: string;
      actor?: string | null;
      reason?: string | null;
    }) => Promise<
      | { ok: true; call: CallRecord; idempotent: boolean }
      | { ok: false; error: 'not_found' | 'stale_call_state' | 'terminal_state' }
    >;
    acquireSweepLease: (instanceId: string, ttlMs: number) => Promise<boolean>;
    releaseSweepLease: (instanceId: string) => Promise<void>;
  };
  sessionState?: {
    get: (sessionId: string) => Promise<SessionRecord | null>;
    save: (session: SessionRecord) => Promise<void>;
    remove: (sessionId: string) => Promise<void>;
  };
  close?: () => Promise<void>;
};
export type IncomingCallPushEntry = {
  acknowledgedDeviceIds: Set<string>;
  pushedDeviceIds: Set<string>;
  ackTimeouts: Map<string, NodeJS.Timeout>;
};
export type AuditLog = {
  record: (entry: {
    event: string;
    actor?: string | null;
    target?: string | null;
    outcome: string;
    details?: object;
  }) => void;
  getForUser: (userId: string) => object[];
};
export type RateLimiter = {
  check: (
    key: string,
    now?: number
  ) => { allowed: boolean; remaining: number; resetAt: number };
};
export type ServerState = Stores & {
  db: import('../../db/client.ts').Database | null;
  auditLog: AuditLog;
  callInitRateLimiter: RateLimiter;
  rtcRateLimiter: RateLimiter;
  turnCredentialsRateLimiter: RateLimiter;
  messageSendRateLimiter: RateLimiter;
  messageSearchRateLimiter: RateLimiter;
  telemetry: import('../telemetry.ts').Telemetry;
  messageStore: import('../messageStore.ts').MessageStore;
  cache: import('../cache.ts').Cache;
  messageBus: import('../messageBus.ts').MessageBus | null;
  draining: boolean;
  incomingCallPushState?: Map<string, IncomingCallPushEntry>;
};

/**
 * Names of every store in a {@link Stores} bundle.  Implementations must
 * provide a value for each of these keys.
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
