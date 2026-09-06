export type CreateServerOptions = {
  verifyIdToken?: (idToken: string) => Promise<{
    authUid: string;
    email?: string | null;
    authProvider?: string | null;
  }>;
  stores?: import('../stores/contracts.ts').Stores;
  db?: import('../../db/client.ts').Database | null;
  messageStore?: import('../messageStore.ts').MessageStore;
  cache?: import('../cache.ts').Cache;
  messageBus?: import('../messageBus.ts').MessageBus | null;
  sessionTtlMs?: number;
  participantDisconnectGraceMs?: number;
  callRateLimit?: number;
  callRateWindowMs?: number;
  rtcRateLimit?: number;
  rtcRateWindowMs?: number;
  turnRateLimit?: number;
  turnRateWindowMs?: number;
  messageRateLimit?: number;
  messageRateWindowMs?: number;
  messageSearchRateLimit?: number;
  messageSearchRateWindowMs?: number;
  shutdownDrainMs?: number;
  staleDeviceMaxAgeMs?: number;
  /** Age past which a terminal `calls` row (and its cascaded events) is deleted; `0` disables. */
  dbCallRetentionMs?: number;
  /** Age past which an `audit_log` row is deleted; `0` disables. */
  auditRetentionMs?: number;
  callRetentionMs?: number;
  maxRetainedCalls?: number;
  turnFetch?: typeof fetch;
  turnEnv?: NodeJS.ProcessEnv;
};
