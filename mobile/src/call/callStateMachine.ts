/**
 * The single call state machine.
 *
 * Every screen derives what it shows from exactly one call state, so the UI
 * never has to reconcile competing sources of truth:
 *
 *   idle ──place──► outgoing_ringing ──connect──► in_call ──end──► ended
 *    │                                   ▲                          │
 *    └──receive──► incoming_ringing ─────┘                    reset─┘
 *
 * `ended` is the short-lived state entered when a call terminates (for any
 * reason: hang-up, decline, cancel, timeout, failure). It exists so consumers
 * can observe the terminal transition; `reset` returns the machine to `idle`
 * once the teardown has been acknowledged.
 *
 * The reducer is pure: transitions that are not legal from the current state
 * are ignored (the state is returned unchanged) rather than throwing, so a
 * late/duplicate signaling event can never corrupt the UI.
 */

export type CallState = 'idle' | 'outgoing_ringing' | 'incoming_ringing' | 'in_call' | 'ended';

export type ParticipantConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

/** UI-safe participant state; the owning call hook keeps the RTCPeerConnection alongside it. */
export type CallPeerState<TStream = unknown> = {
  userId: string;
  connectionState: ParticipantConnectionState;
  stream: TStream | null;
  isMuted: boolean | null;
  isVideoEnabled: boolean | null;
  isScreenSharing: boolean | null;
  quality: 'good' | 'connecting' | 'poor' | 'offline';
  isSpeaking: boolean;
};

export type CallPeerMap<TStream = unknown> = Record<string, CallPeerState<TStream>>;

export type CallPeerEvent<TStream = unknown> =
  | { type: 'join'; userId: string }
  | { type: 'leave'; userId: string }
  | { type: 'connection'; userId: string; connectionState: ParticipantConnectionState }
  | { type: 'stream'; userId: string; stream: TStream | null }
  | { type: 'media'; userId: string; isMuted?: boolean; isVideoEnabled?: boolean; isScreenSharing?: boolean }
  | { type: 'quality'; userId: string; quality: CallPeerState['quality'] }
  | { type: 'speaker'; userId: string; isSpeaking: boolean }
  | { type: 'reset' };

export const INITIAL_CALL_PEERS: CallPeerMap = {};

function createInitialPeer<TStream>(userId: string): CallPeerState<TStream> {
  return {
    userId,
    connectionState: 'new',
    stream: null,
    isMuted: null,
    isVideoEnabled: null,
    isScreenSharing: null,
    quality: 'connecting',
    isSpeaking: false,
  };
}

function qualityForConnection(state: ParticipantConnectionState): CallPeerState['quality'] {
  if (state === 'connected') return 'good';
  if (state === 'failed' || state === 'closed') return 'offline';
  if (state === 'disconnected') return 'poor';
  return 'connecting';
}

function updateForPeerEvent<TStream>(
  current: CallPeerState<TStream>,
  event: Exclude<CallPeerEvent<TStream>, { type: 'join' | 'leave' | 'reset' }>,
): Partial<CallPeerState<TStream>> {
  switch (event.type) {
    case 'connection':
      return {
        connectionState: event.connectionState,
        quality: qualityForConnection(event.connectionState),
      };
    case 'stream':
      return { stream: event.stream };
    case 'media':
      return {
        ...(event.isMuted === undefined ? {} : { isMuted: event.isMuted }),
        ...(event.isVideoEnabled === undefined ? {} : { isVideoEnabled: event.isVideoEnabled }),
        ...('isScreenSharing' in event ? { isScreenSharing: Boolean(event.isScreenSharing) } : {}),
      };
    case 'quality':
      return { quality: event.quality };
    case 'speaker':
      return { isSpeaking: event.isSpeaking };
  }
}

function matchesPeerUpdate<TStream>(
  current: CallPeerState<TStream>,
  update: Partial<CallPeerState<TStream>>,
): boolean {
  return Object.keys(update).every(key =>
    current[key as keyof CallPeerState<TStream>] === update[key as keyof typeof update],
  );
}

/**
 * Participant-scoped media reducer. A failure or leave only changes that
 * participant; the call lifecycle is not ended while another peer is healthy.
 */
export function callPeerMapReducer<TStream = unknown>(
  peers: CallPeerMap<TStream>,
  event: CallPeerEvent<TStream>,
): CallPeerMap<TStream> {
  if (event.type === 'reset') return Object.keys(peers).length ? {} : peers;
  const userId = event.userId.trim();
  if (!userId) return peers;
  if (event.type === 'leave') {
    if (!(userId in peers)) return peers;
    const next = { ...peers };
    delete next[userId];
    return next;
  }
  const current = peers[userId];
  if (event.type === 'join') {
    if (current) return peers;
    return {
      ...peers,
      [userId]: createInitialPeer(userId),
    };
  }
  if (!current) return peers;
  const update = updateForPeerEvent(current, event);
  return matchesPeerUpdate(current, update)
    ? peers
    : { ...peers, [userId]: { ...current, ...update } };
}
export const CALL_STATES = {
  IDLE: 'idle',
  OUTGOING_RINGING: 'outgoing_ringing',
  INCOMING_RINGING: 'incoming_ringing',
  IN_CALL: 'in_call',
  ENDED: 'ended',
};

export type CallEvent = 'place' | 'receive' | 'connect' | 'end' | 'reset';
export const CALL_EVENTS = {
  /** Local user placed a call (outgoing ringing). */
  PLACE: 'place',
  /** An incoming call arrived (incoming ringing). */
  RECEIVE: 'receive',
  /** Media negotiated — the call is connected. */
  CONNECT: 'connect',
  /** The call terminated, for any reason. */
  END: 'end',
  /** Teardown acknowledged — return to idle. */
  RESET: 'reset',
};

export const INITIAL_CALL_STATE = CALL_STATES.IDLE;

/**
 * Legal transitions, keyed by state then event. A state/event pair that is
 * absent from the table is a no-op.
 */
const TRANSITIONS: Record<string, Record<string, string>> = {
  [CALL_STATES.IDLE]: {
    [CALL_EVENTS.PLACE]: CALL_STATES.OUTGOING_RINGING,
    [CALL_EVENTS.RECEIVE]: CALL_STATES.INCOMING_RINGING,
    // A call rehydrated from a push notification / CallKeep answer can connect
    // without this device ever having rendered a ringing screen.
    [CALL_EVENTS.CONNECT]: CALL_STATES.IN_CALL,
  },
  [CALL_STATES.OUTGOING_RINGING]: {
    [CALL_EVENTS.CONNECT]: CALL_STATES.IN_CALL,
    [CALL_EVENTS.END]: CALL_STATES.ENDED,
  },
  [CALL_STATES.INCOMING_RINGING]: {
    [CALL_EVENTS.CONNECT]: CALL_STATES.IN_CALL,
    [CALL_EVENTS.END]: CALL_STATES.ENDED,
  },
  [CALL_STATES.IN_CALL]: {
    [CALL_EVENTS.END]: CALL_STATES.ENDED,
  },
  [CALL_STATES.ENDED]: {
    [CALL_EVENTS.RESET]: CALL_STATES.IDLE,
  },
};

/**
 * Pure reducer for the call state machine.
 *
 * @param state current state
 * @param event event (or `{ type }` action)
 * @returns the next state, or `state` when the transition is not legal
 */
export function callStateReducer(state: string, event: string | { type: string; }): string {
  const type = typeof event === 'string' ? event : event?.type;
  return TRANSITIONS[state]?.[type] ?? state;
}

/**
 * @returns true while a call is ringing in either direction
 */
export function isRingingState(state: string): boolean {
  return state === CALL_STATES.OUTGOING_RINGING || state === CALL_STATES.INCOMING_RINGING;
}

/**
 * @returns true while a call occupies the device (ringing or connected)
 */
export function isCallActiveState(state: string): boolean {
  return state !== CALL_STATES.IDLE && state !== CALL_STATES.ENDED;
}
