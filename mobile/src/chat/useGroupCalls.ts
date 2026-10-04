import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SERVER_EVENTS } from '../../../shared';
import { logWarn } from '../appLogger';
import { createMessageId } from '../messaging/messageIdentity';
import {
  groupCallAcknowledgement, groupCallRequest, parseGroupCallSnapshot, startMockGroupCall, transitionMockGroupCall,
} from './groupCallAdapter';
import type { GroupCallAction, GroupCallSnapshot } from './groupCallAdapter';
import type { ConversationSummary } from '../messaging/types';
import type { SignalingClient } from '../signalingClient';
import type { Socket } from 'socket.io-client';

/** How many superseded call ids stay suppressed; older ones cannot recur. */
const RETIRED_CALL_LIMIT = 64;

type Params = {
  scope: string;
  userId: string;
  conversationsRef: { current: ConversationSummary[] };
  signalingRef: { current: SignalingClient | null };
  socketRef: { current: Socket | null };
  connected: boolean | null;
};

/** Contract-aware lifecycle adapter; no media, permissions, RTC or peer-call events. */
export default function useGroupCalls({ scope, userId, conversationsRef, signalingRef, socketRef, connected }: Params) {
  const [groupCalls, setGroupCalls] = useState<Record<string, GroupCallSnapshot>>({});
  const held = useRef<Record<string, GroupCallSnapshot>>({});
  const retired = useRef(new Set<string>());
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    held.current = {};
    retired.current.clear();
    setGroupCalls({});
  }, [scope]);

  const receive = useCallback((payload: unknown) => {
    const snapshot = parseGroupCallSnapshot(payload);
    const row = conversationsRef.current.find(entry => entry.conversationId === snapshot.conversationId && entry.group);
    if (!row || row.left || !row.group!.memberIds.includes(userId)) return;
    if (!snapshot.participants.some(person => person.userId === userId)) return;
    const previous = held.current[row.peerId];
    if (retired.current.has(snapshot.callId)) return;
    if (previous?.callId === snapshot.callId && previous.call.stateVersion >= snapshot.call.stateVersion) return;
    if (previous && previous.callId !== snapshot.callId) {
      if (snapshot.call.status === 'ended') return;
      // Bounded: only the most recent superseded calls need to stay suppressed.
      if (retired.current.size >= RETIRED_CALL_LIMIT) {
        const oldest = retired.current.values().next().value;
        if (oldest !== undefined) retired.current.delete(oldest);
      }
      retired.current.add(previous.callId);
    }
    held.current = { ...held.current, [row.peerId]: snapshot };
    setGroupCalls(held.current);
  }, [conversationsRef, userId]);

  useEffect(() => {
    if (!scope || !connected || !signalingRef.current) return undefined;
    return signalingRef.current.on(SERVER_EVENTS.CONVERSATION_CALL_UPDATED, payload => {
      if (scopeRef.current !== scope) return;
      try { receive(payload); }
      catch { logWarn('[GroupCalls] Dropped inconsistent group call snapshot'); }
    });
  }, [scope, connected, signalingRef, receive]);

  const groupCallActions = useMemo(() => {
    const find = (id: string) => {
      if (!scope || scopeRef.current !== scope) throw new Error('Account changed');
      const row = conversationsRef.current.find(entry => entry.peerId === id && entry.group);
      if (!row || row.left || !row.group!.memberIds.includes(userId)) throw new Error('You are not a group member');
      return row;
    };
    const request = async (action: 'start' | GroupCallAction, id: string, mediaType?: 'audio' | 'video') => {
      if (!socketRef.current?.connected || !signalingRef.current) throw new Error('Connect before changing a group call');
      const { event, payload } = groupCallRequest(action, id, mediaType);
      const ack = await signalingRef.current.request(event, payload);
      if (scopeRef.current !== scope) throw new Error('Account changed');
      const snapshot = groupCallAcknowledgement(ack);
      const acknowledgedId = action === 'start' ? snapshot.conversationId : snapshot.callId;
      if (acknowledgedId !== id) throw new Error('Server acknowledged a different group call');
      receive(snapshot);
    };
    const transition = async (id: string, action: GroupCallAction) => {
      const row = find(id);
      const snapshot = held.current[id];
      if (!snapshot) throw new Error('Group call is unavailable');
      if (row.localMock) receive(transitionMockGroupCall(snapshot, userId, action, new Date().toISOString()));
      else await request(action, snapshot.callId);
    };
    return {
      start: async (id: string, mediaType: 'audio' | 'video' = 'audio') => {
        const row = find(id);
        const existing = held.current[id];
        if (existing && existing.call.status !== 'ended') throw new Error('A group call is already open');
        if (row.localMock) receive(startMockGroupCall(row, userId, `mock-call-${createMessageId()}`, mediaType, new Date().toISOString()));
        else await request('start', row.group!.conversationId, mediaType);
      },
      transition,
      simulate: async (id: string, memberId: string, action: GroupCallAction) => {
        const row = find(id);
        if (!row.localMock || memberId === userId) throw new Error('Only other local preview participants can be simulated');
        const snapshot = held.current[id];
        if (!snapshot) throw new Error('Group call is unavailable');
        receive(transitionMockGroupCall(snapshot, memberId, action, new Date().toISOString()));
      },
    };
  }, [scope, userId, conversationsRef, signalingRef, socketRef, receive]);
  return { groupCalls, groupCallActions, receiveGroupCallSnapshot: receive };
}
