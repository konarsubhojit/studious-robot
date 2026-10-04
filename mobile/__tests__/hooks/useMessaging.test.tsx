import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import RNFS from 'react-native-fs';
import useMessaging from '../../src/hooks/useMessaging';
import { createSignalingClient } from '../../src/signalingClient';
import {
  dismissMessageNotification,
  markMessageSeen,
  setActiveConversation,
} from '../../src/messageNotification';
import { displayMessageReceivedInApp } from '../../src/pushNotifications';
import * as chatDb from '../../src/storage/chatDb';
import * as resourceCache from '../../src/storage/resourceCache';
import { triggerHapticUnlessSilent } from '../../src/haptics';
import { evictCachedAttachmentsForMessage } from '../../src/attachmentCache';
import { createMockGroup } from '../../src/chat/groupMockAdapter';
import { startMockGroupCall, transitionMockGroupCall } from '../../src/chat/groupCallAdapter';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

jest.mock('../../src/haptics', () => ({
  triggerHapticUnlessSilent: jest.fn(async () => true),
}));

jest.mock('../../src/messageNotification', () => ({
  dismissMessageNotification: jest.fn(),
  markMessageSeen: jest.fn(),
  setActiveConversation: jest.fn(),
}));

jest.mock('../../src/pushNotifications', () => ({
  displayMessageReceivedInApp: jest.fn(async () => ({ shown: true })),
}));

jest.mock('../../src/attachmentCache', () => ({
  evictCachedAttachmentsForMessage: jest.fn(async () => 0),
}));

// In-memory stand-in for the durable local store, so the hook's hydration and
// persistence can be observed without touching the filesystem.
jest.mock('../../src/storage/chatDb', () => {
  const snapshot = { conversations: [], messagesByPeer: {}, socketCursors: {}, outbox: [] };
  return {
    __snapshot: snapshot,
    loadChatSnapshot: jest.fn(async () => snapshot),
    saveChatSnapshot: jest.fn(partial => Object.assign(snapshot, partial)),
    flushChatDb: jest.fn(async () => {}),
  };
});

jest.mock('../../src/storage/resourceCache', () => ({
  readResource: jest.fn(async () => null),
  writeResource: jest.fn(async () => {}),
}));

function TestHook({ resultRef, params }: any) {
  resultRef.current = useMessaging(params);
  return null;
}

function makeSocket({ connected = true, ackResponse = { ok: true, message: null } }: any = {}) {
  const listeners = new Map<string, Function>();
  return {
    connected,
    on: jest.fn((event, handler) => { listeners.set(event, handler); }),
    off: jest.fn((event) => { listeners.delete(event); }),
    receive: (event: string, payload: object) => listeners.get(event)?.(payload),
    emit: jest.fn((event, payload, callback) => {
      if (typeof callback === 'function') callback(ackResponse);
    }),
  };
}

function setup(overrides = {}) {
  const params: any = {
    authedFetchRef: { current: jest.fn() },
    sessionIdRef: { current: 'sess-1' },
    signalingUrl: 'https://signal.example.com',
    socketRef: { current: makeSocket() },
    userId: 'alice',
    updateStatus: jest.fn(),
    ...overrides,
  };
  // The hook emits through the typed signaling client, which wraps the socket
  // under test, so socket-level assertions still observe every emit.
  params.signalingRef = params.signalingRef ?? {
    current: createSignalingClient(params.socketRef.current),
  };
  const resultRef: { current: any; } = { current: null };
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  mountedTrees.push(tree);
  return { resultRef, params, tree };
}

/** Rendered hooks, unmounted after each test so the outbox retry timer that
 * an unsent message arms cannot outlive the test that queued it. */
const mountedTrees: any = [];

describe('durable attachment outbox', () => {
  const attachment = { url: 'file:///photo.jpg', mimeType: 'image/jpeg', sizeBytes: 123 };
  const response = (body: object) => ({ ok: true, json: async () => body });

  test('compose offline queues an app-owned file and progress; only the drain calls prepare', async () => {
    const socket = makeSocket({ connected: false });
    const authedFetch = jest.fn(async build => {
      const body = JSON.parse(build('session').options.body);
      expect(body).toMatchObject({ action: 'prepare', peerId: 'bob', sizeBytes: 123 });
      return response({ key: 'chatblobs/alice_bob/photo.jpg', reference: 'chatblobs/alice_bob/photo.jpg', completed: true });
    });
    const { resultRef } = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    let id!: string;
    await act(async () => {
      id = resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
      resultRef.current.updateAttachmentUploadProgress('bob', id, 0.25);
    });
    const stored = (chatDb as any).__snapshot.outbox[0];
    expect(stored).toMatchObject({ messageId: id, body: '', upload: { progress: 0.25, parts: [] } });
    expect(stored.upload.uri).toContain(`/wetalk-upload-${id}`);
    expect(JSON.stringify(stored)).not.toMatch(/X-Amz-|https:\/\//);
    expect(authedFetch).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
    expect(chatDb.flushChatDb).toHaveBeenCalled();
    expect(resultRef.current.pendingSendCount).toBe(1);
    expect(resultRef.current.messagesByPeer.bob[0].deliveryState).toBe('queued');
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(authedFetch).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('message.send',
      expect.objectContaining({ clientMessageId: id, attachment: { ...attachment, url: 'chatblobs/alice_bob/photo.jpg' } }),
      expect.any(Function));
    expect((chatDb as any).__snapshot.outbox).toHaveLength(0);
    expect(resultRef.current.pendingSendCount).toBe(0);
    expect(resultRef.current.messagesByPeer.bob[0].deliveryState).toBe('sent');
  });

  test.each(['original', 'client', 'server'])(
    'resumable attachment retry and discard resolve %s without changing upload identity', async identity => {
      const createdAt = '2026-10-03T06:00:00.000Z';
      const original = {
        messageId: 'original', clientMessageId: 'client', recipientId: 'bob', createdAt,
        type: 'image', attachment, state: 'failed', attempts: 5,
        upload: { uri: 'file:///documents/wetalk-upload-original', uploadId: 'multipart',
          parts: [{ partNumber: 1, etag: 'etag-1', sizeBytes: 60 }], progress: 60 / 123 },
      };
      const unrelated = { ...original, recipientId: 'carol', messageId: 'other', clientMessageId: 'other' };
      (chatDb as any).__snapshot.outbox = [original, unrelated];
      (chatDb as any).__snapshot.messagesByPeer = { bob: [{
        ...original, messageId: 'server', senderId: 'alice', uploadState: 'failed', uploadError: 'network failure',
      }] };
      const socket = makeSocket({ connected: false });
      const authedFetch = jest.fn(async build => {
        const body = JSON.parse(build('session').options.body);
        expect(body).toMatchObject({ action: 'abort', clientId: 'client', peerId: 'bob', uploadId: 'multipart' });
        return response({ cleanupComplete: true });
      });
      const first = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
      await act(async () => {});
      expect(first.resultRef.current.pendingSendCount).toBe(0);
      await act(async () => {
        await first.resultRef.current.finishAttachmentUpload('bob', identity, 'image', attachment);
      });
      expect((chatDb as any).__snapshot.outbox).toHaveLength(2);
      expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({
        messageId: 'original', clientMessageId: 'client', state: 'pending', attempts: 0, upload: original.upload,
      });
      expect(first.resultRef.current.pendingSendCount).toBe(1);
      expect(first.resultRef.current.messagesByPeer.bob).toHaveLength(1);
      expect(first.resultRef.current.messagesByPeer.bob[0]).toMatchObject({
        messageId: 'server', clientMessageId: 'client', deliveryState: 'queued', uploadState: 'uploading',
        uploadProgress: original.upload.progress, uploadError: null,
      });
      // Worker progress uses the original outbox id even after history reconciliation.
      act(() => first.resultRef.current.updateAttachmentUploadProgress('bob', 'original', 0.75));
      expect(first.resultRef.current.messagesByPeer.bob[0].uploadProgress).toBe(0.75);
      act(() => first.resultRef.current.discardMessage('bob', identity));
      expect(first.resultRef.current.messagesByPeer.bob).toEqual([]);
      expect(first.resultRef.current.pendingSendCount).toBe(0);
      expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ discarded: true, upload: { progress: 0.75 } });
      expect((chatDb as any).__snapshot.outbox[1]).toEqual(unrelated);
      await act(async () => {
        await first.resultRef.current.finishAttachmentUpload('bob', identity, 'image', attachment);
        await first.resultRef.current.retryMessage('bob', identity);
      });
      expect((chatDb as any).__snapshot.outbox[0].discarded).toBe(true);
      expect(authedFetch).not.toHaveBeenCalled();
      act(() => first.tree.unmount());
      const restarted = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
      await act(async () => {});
      expect(restarted.resultRef.current.messagesByPeer.bob).toEqual([]);
      expect(restarted.resultRef.current.pendingSendCount).toBe(0);
      socket.connected = true;
      await act(async () => { await restarted.resultRef.current.drainOutbox(); });
      expect((chatDb as any).__snapshot.outbox).toEqual([unrelated]);
      expect(socket.emit).not.toHaveBeenCalled();
    },
  );

  test('attachment retry without an upload checkpoint retains reconciled client identity and compose time', async () => {
    const createdAt = '2026-10-03T06:00:00.000Z';
    const original = {
      messageId: 'original', clientMessageId: 'client', recipientId: 'bob', createdAt,
      type: 'image', attachment, state: 'failed', attempts: 5,
    };
    (chatDb as any).__snapshot.outbox = [original];
    (chatDb as any).__snapshot.messagesByPeer = { bob: [{
      ...original, messageId: 'server', senderId: 'alice', uploadState: 'failed',
    }] };
    const { resultRef } = setup({ socketRef: { current: makeSocket({ connected: false }) } });
    await act(async () => {});
    const uploaded = { ...attachment, url: 'chatblobs/alice_bob/photo.jpg' };
    await act(async () => { await resultRef.current.finishAttachmentUpload('bob', 'server', 'image', uploaded); });
    expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({
      messageId: 'original', clientMessageId: 'client', createdAt, state: 'pending', attempts: 0, attachment: uploaded,
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      messageId: 'server', deliveryState: 'queued', uploadState: undefined, attachment: uploaded,
    });
    expect(resultRef.current.pendingSendCount).toBe(1);
  });

  test.each(['direct', 'group'])('resumable %s retry transitions from queued through sending to sent under the original client id', async kind => {
    const peerId = kind === 'group' ? 'live-group' : 'bob';
    const createdAt = '2026-10-03T06:00:00.000Z';
    const reference = `chatblobs/${peerId}/photo.jpg`;
    if (kind === 'group') {
      const row = createMockGroup('alice', 'Team', ['bob', 'carol'], peerId);
      row.localMock = false;
      (chatDb as any).__snapshot.conversations = [row];
    }
    const original = {
      messageId: 'original', clientMessageId: 'client', recipientId: peerId, createdAt,
      type: 'image', attachment, state: 'failed', attempts: 5,
      upload: { uri: 'file:///documents/wetalk-upload-original', parts: [], progress: 0.5 },
      ...(kind === 'group' ? { targetKind: 'group', conversationId: peerId } : {}),
    };
    (chatDb as any).__snapshot.outbox = [original];
    (chatDb as any).__snapshot.messagesByPeer = { [peerId]: [{
      ...original, messageId: 'server', senderId: 'alice', uploadState: 'failed', uploadError: 'offline',
    }] };
    const socket = makeSocket({ connected: false });
    let acknowledge!: (value: object) => void;
    let sent!: () => void;
    const sentPromise = new Promise<void>(resolve => { sent = resolve; });
    socket.emit.mockImplementation((_event, _payload, ack) => { acknowledge = ack; sent(); });
    const authedFetch = jest.fn(async build => {
      expect(JSON.parse(build('session').options.body)).toMatchObject({
        action: 'prepare', clientId: 'client',
        ...(kind === 'group' ? { groupId: peerId } : { peerId }),
      });
      return response({ key: reference, reference, completed: true });
    });
    const { resultRef } = setup({
      socketRef: { current: socket }, authedFetchRef: { current: authedFetch }, groupTransport: 'live',
    });
    await act(async () => {});
    await act(async () => { await resultRef.current.retryMessage(peerId, 'server'); });
    expect(resultRef.current.pendingSendCount).toBe(1);
    expect(resultRef.current.messagesByPeer[peerId][0]).toMatchObject({
      deliveryState: 'queued', uploadState: 'uploading', uploadError: null,
    });
    expect(authedFetch).not.toHaveBeenCalled();
    socket.connected = true;
    let draining!: Promise<void>;
    await act(async () => { draining = resultRef.current.drainOutbox(); await sentPromise; });
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('message.send', expect.objectContaining({
      clientMessageId: 'client', attachment: { ...attachment, url: reference },
      ...(kind === 'group' ? { conversationId: peerId } : { recipientId: peerId }),
    }), expect.any(Function));
    expect(resultRef.current.messagesByPeer[peerId][0]).toMatchObject({
      messageId: 'server', deliveryState: 'sending', uploadState: undefined,
    });
    expect(resultRef.current.pendingSendCount).toBe(1);
    await act(async () => {
      acknowledge({ ok: true, message: {
        messageId: 'server', clientMessageId: 'client', senderId: 'alice', recipientId: peerId, createdAt,
      } });
      await draining;
    });
    expect(resultRef.current.messagesByPeer[peerId]).toHaveLength(1);
    expect(resultRef.current.messagesByPeer[peerId][0]).toMatchObject({ messageId: 'server', deliveryState: 'sent' });
    expect(resultRef.current.pendingSendCount).toBe(0);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('offline discard survives restart and retries cleanup before a durable delayed final sweep', async () => {
    const socket = makeSocket({ connected: false });
    const cleanupAfter = Date.now() + 60_000;
    const actions: string[] = [];
    const authedFetch = jest.fn(async build => {
      actions.push(JSON.parse(build('session').options.body).action);
      return response({ aborted: true, cleanupAfter });
    });
    const first = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    let id!: string;
    await act(async () => {
      id = first.resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await first.resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
      first.resultRef.current.discardMessage('bob', id);
    });
    expect(first.resultRef.current.messagesByPeer.bob).toEqual([]);
    expect(first.resultRef.current.pendingSendCount).toBe(0);
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ discarded: true, upload: { parts: [] } });
    expect(authedFetch).not.toHaveBeenCalled();
    act(() => first.tree.unmount());
    const restarted = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    await act(async () => { await Promise.resolve(); });
    expect(restarted.resultRef.current.messagesByPeer.bob).toEqual([]);
    socket.connected = true;
    await act(async () => { await restarted.resultRef.current.drainOutbox(); });
    expect(actions).toEqual(['abort']);
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ discarded: true, cleanupAfter, nextAttemptAt: cleanupAfter });
    act(() => restarted.resultRef.current.discardMessage('bob', id));
    await act(async () => { await restarted.resultRef.current.drainOutbox(); });
    expect(actions).toEqual(['abort']);
    expect((chatDb as any).__snapshot.outbox[0].nextAttemptAt).toBe(cleanupAfter);
    expect(socket.emit).not.toHaveBeenCalled();
    await drainAtNextDeadline(restarted.resultRef);
    expect(actions).toEqual(['abort', 'abort']);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('discard during a delayed prepare cannot resurrect an attachment or emit its message', async () => {
    const socket = makeSocket({ connected: true });
    let release!: (value: any) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const actions: string[] = [];
    const authedFetch = jest.fn(build => {
      const action = JSON.parse(build('session').options.body).action;
      actions.push(action);
      if (action === 'prepare') {
        started();
        return new Promise(resolve => { release = resolve; });
      }
      return Promise.resolve(response({ aborted: true, cleanupAfter: Date.now() + 60_000 }));
    });
    const { resultRef } = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    let id!: string;
    await act(async () => {
      id = resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
      await startedPromise;
      socket.connected = false;
      resultRef.current.discardMessage('bob', id);
      release(response({ key: 'chatblobs/alice_bob/photo.jpg', reference: 'chatblobs/alice_bob/photo.jpg', completed: true }));
      await Promise.resolve();
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([]);
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ discarded: true });
    expect(socket.emit).not.toHaveBeenCalled();
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(actions).toEqual(['prepare', 'abort']);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('a late send acknowledgement preserves discard until reconciliation deletes the server message before storage', async () => {
    const socket = makeSocket({ connected: false });
    let acknowledge!: (value: any) => void;
    socket.emit.mockImplementation((_event, _payload, ack) => { acknowledge = ack; });
    const authedFetch = jest.fn(async () => response({
      key: 'chatblobs/alice_bob/photo.jpg', reference: 'chatblobs/alice_bob/photo.jpg', completed: true,
    }));
    const { resultRef } = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    let id!: string;
    await act(async () => {
      id = resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
    });
    socket.connected = true;
    let drain!: Promise<void>;
    await act(async () => {
      drain = resultRef.current.drainOutbox();
      for (let i = 0; i < 30 && !acknowledge; i++) await Promise.resolve();
    });
    expect(acknowledge).toBeDefined();
    await act(async () => {
      socket.connected = false;
      resultRef.current.discardMessage('bob', id);
      acknowledge({ ok: true, message: { messageId: 'accepted-remotely', clientMessageId: id } });
      await drain;
    });
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ messageId: id, discarded: true });
    expect(resultRef.current.messagesByPeer.bob).toEqual([]);
    const operations: string[] = [];
    socket.emit.mockImplementation((event, payload, ack) => {
      operations.push(event);
      if (event === 'message.send') {
        expect(payload.clientMessageId).toBe(id);
        ack({ ok: true, message: { messageId: 'accepted-remotely', clientMessageId: id } });
      } else {
        expect(payload.messageId).toBe('accepted-remotely');
        ack({ ok: true });
      }
    });
    authedFetch.mockImplementation(async () => {
      operations.push('abort');
      return response({ cleanupComplete: true });
    });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(operations).toEqual(['message.send', 'message.delete', 'abort']);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('acknowledged source cleanup failure retains the completed row for a source-free retry', async () => {
    const socket = makeSocket({ connected: false });
    const authedFetch = jest.fn(async () => response({
      key: 'chatblobs/alice_bob/photo.jpg', reference: 'chatblobs/alice_bob/photo.jpg', completed: true,
    }));
    const { resultRef } = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    await act(async () => {
      const id = resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
    });
    (RNFS.unlink as jest.Mock).mockRejectedValueOnce(new Error('disk busy'));
    (RNFS.exists as jest.Mock).mockResolvedValueOnce(true);
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ upload: { completed: true } });
    await drainAtNextDeadline(resultRef);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
    expect(authedFetch).toHaveBeenCalledTimes(1);
  });

  test('lost send/delete acknowledgements never allow storage cleanup before a confirmed server tombstone', async () => {
    (chatDb as any).__snapshot.outbox = [{
      messageId: 'discarded-client', clientMessageId: 'discarded-client', recipientId: 'bob',
      body: '', type: 'image', discarded: true,
      attachment: { ...attachment, url: 'file:///photo.jpg' },
      upload: { uri: 'file:///photo.jpg', key: 'chatblobs/alice_bob/photo.jpg', completed: true, parts: [], progress: 1 },
    }];
    const request = jest.fn()
      .mockResolvedValueOnce({ message: { messageId: 'server-id' } })
      .mockRejectedValueOnce(new Error('delete ack lost'))
      .mockResolvedValueOnce({ message: { messageId: 'server-id', deletedAt: '2026-10-04T00:00:00Z' } });
    const authedFetch = jest.fn(async () => response({ cleanupComplete: true }));
    const { resultRef } = setup({
      signalingRef: { current: { request, on: jest.fn(() => jest.fn()) } },
      authedFetchRef: { current: authedFetch },
    });
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(authedFetch).not.toHaveBeenCalled();
    expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
    expect(request.mock.calls[0][1].attachment.url).toBe('chatblobs/alice_bob/photo.jpg');
    await drainAtNextDeadline(resultRef);
    expect(request.mock.calls.map(([event]) => event)).toEqual(['message.send', 'message.delete', 'message.send']);
    expect(authedFetch).toHaveBeenCalledTimes(1);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('discard cleanup failure retains the durable row until local unlink succeeds', async () => {
    const socket = makeSocket({ connected: false });
    const authedFetch = jest.fn(async () => response({ cleanupComplete: true }));
    const { resultRef } = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    await act(async () => {
      const id = resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
      resultRef.current.discardMessage('bob', id);
    });
    (RNFS.unlink as jest.Mock).mockRejectedValueOnce(new Error('disk busy'));
    (RNFS.exists as jest.Mock).mockResolvedValueOnce(true);
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ discarded: true });
    await drainAtNextDeadline(resultRef);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('upload throttling waits for the server delay without exhausting send attempts', async () => {
    const socket = makeSocket({ connected: false });
    const authedFetch = jest.fn(async () => ({
      ok: false, status: 429, json: async () => ({ retryAfter: 60 }),
    }));
    const { resultRef } = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    await act(async () => {
      const id = resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
    });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    for (let i = 0; i < 5; i++) await drainAtNextDeadline(resultRef);
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ attempts: 0, state: 'pending' });
    expect((chatDb as any).__snapshot.outbox[0].nextAttemptAt).toBeGreaterThan(Date.now() + 50_000);
  });

  test('server cleanup approval and relative delays protect against device clock skew', async () => {
    const socket = makeSocket({ connected: false });
    let cleanupCalls = 0;
    const authedFetch = jest.fn(async () => {
      cleanupCalls++;
      return response({ aborted: true, cleanupAfter: 1, retryAfterMs: cleanupCalls < 3 ? 5000 : 0,
        cleanupComplete: cleanupCalls >= 3 });
    });
    const { resultRef } = setup({ socketRef: { current: socket }, authedFetchRef: { current: authedFetch } });
    let id!: string;
    await act(async () => {
      id = resultRef.current.beginAttachmentUpload('bob', 'image', attachment);
      await resultRef.current.finishAttachmentUpload('bob', id, 'image', attachment);
      resultRef.current.discardMessage('bob', id);
    });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect((chatDb as any).__snapshot.outbox[0].cleanupAfter).toBeGreaterThan(Date.now());
    await drainAtNextDeadline(resultRef);
    expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
    await drainAtNextDeadline(resultRef);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
    expect(cleanupCalls).toBe(3);
  });
});

/** Retry tests advance the wall clock to the persisted deadline instead of bypassing backoff. */
async function drainAtNextDeadline(resultRef: { current: any }) {
  const deadlines = (chatDb as any).__snapshot.outbox
    .filter((item: any) => item.state !== 'failed' && (item.attempts ?? 0) < 5)
    .map((item: any) => item.nextAttemptAt ?? Date.now());
  const now = jest.spyOn(Date, 'now').mockReturnValue(Math.max(Date.now(), ...deadlines));
  try {
    await act(async () => { await resultRef.current.drainOutbox(); });
  } finally {
    now.mockRestore();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  (chatDb as any).__snapshot.conversations = [];
  (chatDb as any).__snapshot.messagesByPeer = {};
  (chatDb as any).__snapshot.socketCursors = {};
  (chatDb as any).__snapshot.outbox = [];
  (resourceCache.readResource as jest.Mock).mockResolvedValue(null);
  (resourceCache.writeResource as jest.Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => {
    mountedTrees.splice(0).forEach((tree: any) => tree.unmount());
  });
});

describe('useMessaging', () => {
  test('cold restart fails an interrupted upload and its reply without blocking later sends', async () => {
    const parentKey = 'interrupted-upload';
    (chatDb as any).__snapshot.messagesByPeer = { bob: [{
      messageId: parentKey, clientMessageId: parentKey, senderId: 'alice', recipientId: 'bob',
      body: '', type: 'image', attachment: { url: 'file://preview.jpg' },
      createdAt: '2026-10-03T06:00:00.000Z', syncState: 'pending', pending: true, uploadState: 'uploading',
    }] };
    (chatDb as any).__snapshot.outbox = [
      { messageId: 'dependent-reply', clientMessageId: 'dependent-reply', recipientId: 'bob',
        body: 'reply', replyTo: parentKey, replyToLocalMessageId: parentKey,
        createdAt: '2026-10-03T06:00:01.000Z', attempts: 0 },
      { messageId: 'later-send', clientMessageId: 'later-send', recipientId: 'bob',
        body: 'independent', createdAt: '2026-10-03T06:00:02.000Z', attempts: 0 },
    ];
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    await act(async () => {});
    expect(resultRef.current.messagesByPeer.bob.find((entry: any) => entry.messageId === parentKey))
      .toMatchObject({ uploadState: 'failed', syncState: 'failed', failed: true });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('message.send',
      expect.objectContaining({ body: 'independent', clientMessageId: 'later-send' }), expect.any(Function));
    expect((chatDb as any).__snapshot.outbox).toEqual([
      expect.objectContaining({ messageId: 'dependent-reply', clientMessageId: 'dependent-reply', attempts: 5 }),
    ]);
  });

  test('a delayed send ack preserves a newer call preview while reconciling the message', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });
    let acknowledge!: (payload: any) => void;
    let payload!: any;
    socket.emit.mockImplementation((_event, sent, ack) => { payload = sent; acknowledge = ack; });
    let sending!: Promise<unknown>;
    await act(async () => { sending = resultRef.current.sendMessage('bob', 'older send'); });
    expect(acknowledge).toEqual(expect.any(Function));
    const local = resultRef.current.messagesByPeer.bob[0];
    const call = {
      type: 'call' as const, callId: 'newer-call', conversationId: 'alice:bob',
      direction: 'outgoing' as const, status: 'completed',
      createdAt: new Date(Date.parse(local.createdAt) + 5000).toISOString(),
    };
    await act(async () => { resultRef.current.recordCallActivity('bob', call); });
    await act(async () => {
      acknowledge({ ok: true, message: {
        ...payload, messageId: 'server-delayed', senderId: 'alice', recipientId: 'bob',
        conversationId: 'alice:bob', createdAt: new Date(Date.parse(local.createdAt) + 1000).toISOString(),
      } });
      await sending;
    });
    const row = resultRef.current.conversations.find((entry: any) => entry.peerId === 'bob');
    expect(row.lastMessage).toMatchObject({ messageId: 'server-delayed', clientMessageId: payload.clientMessageId });
    expect(row.lastActivity).toEqual(call);
    expect(row.lastActivity.createdAt).toBe(call.createdAt);
    expect((chatDb as any).__snapshot.outbox).toHaveLength(0);
  });

  test.each(['exhausted', 'missing'])('a reply to an %s parent fails locally without blocking independent sends', async kind => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    let parentKey!: string;
    let replyKey!: string;
    await act(async () => {
      parentKey = await resultRef.current.sendMessage('bob', 'parent');
      replyKey = await resultRef.current.sendMessage('bob', 'reply', { replyTo: parentKey });
      await resultRef.current.sendMessage('bob', 'bob-1');
      await resultRef.current.sendMessage('carol', 'carol-1');
      await resultRef.current.sendMessage('bob', 'bob-2');
    });
    expect((chatDb as any).__snapshot.outbox.find((item: any) => item.messageId === replyKey).replyToLocalMessageId).toBe(parentKey);
    if (kind === 'missing') act(() => resultRef.current.discardMessage('bob', parentKey));
    const sent: any[] = [];
    socket.emit.mockImplementation((_event, payload, ack) => {
      sent.push(payload);
      ack(payload.body === 'parent' ? { ok: false, error: { message: 'cannot send parent' } } : {
        ok: true, message: {
          ...payload, messageId: `server-${payload.body}`, senderId: 'alice',
          conversationId: `alice:${payload.recipientId}`, createdAt: '2026-10-03T06:00:00.000Z',
        },
      });
    });
    socket.connected = true;
    if (kind === 'exhausted') {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await drainAtNextDeadline(resultRef);
      }
    }
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(sent.filter(payload => payload.body !== 'parent').map(payload => payload.body))
      .toEqual(kind === 'exhausted' ? ['carol-1', 'bob-1', 'bob-2'] : ['bob-1', 'carol-1', 'bob-2']);
    expect(sent.some(payload => payload.body === 'reply')).toBe(false);
    const failedReply = (chatDb as any).__snapshot.outbox.find((item: any) => item.messageId === replyKey);
    expect(failedReply).toMatchObject({ clientMessageId: replyKey, attempts: 5 });
    expect(failedReply.lastError).toContain(kind === 'exhausted' ? 'failed' : 'no longer available');
    expect(resultRef.current.messagesByPeer.bob.find((entry: any) => entry.clientMessageId === replyKey).syncState).toBe('failed');
    expect((chatDb as any).__snapshot.outbox.every((item: any) => item.attempts === 5)).toBe(true);
  });

  test('a reply awaiting an upload preserves its conversation order but does not block another conversation', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    let parentKey!: string;
    await act(async () => {
      parentKey = resultRef.current.beginAttachmentUpload('bob', 'image', { url: 'file://preview.jpg' });
      await resultRef.current.sendMessage('bob', 'reply', { replyTo: parentKey });
      await resultRef.current.sendMessage('bob', 'following');
      await resultRef.current.sendMessage('carol', 'independent');
    });
    const sent: string[] = [];
    socket.emit.mockImplementation((_event, payload, ack) => {
      sent.push(payload.body || 'attachment');
      ack({ ok: true, message: {
        ...payload, messageId: `server-${payload.body || 'attachment'}`, senderId: 'alice',
        conversationId: `alice:${payload.recipientId}`, createdAt: '2026-10-03T06:00:00.000Z',
      } });
    });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(sent).toEqual(['independent']);
    expect((chatDb as any).__snapshot.outbox.map((item: any) => item.body)).toEqual(['reply', 'following']);
    await act(async () => {
      await resultRef.current.finishAttachmentUpload('bob', parentKey, 'image',
        { url: 'chatblobs/alice_bob/parent.jpg', mimeType: 'image/jpeg', sizeBytes: 123 });
    });
    expect(sent).toEqual(['independent', 'attachment', 'reply', 'following']);
    expect((chatDb as any).__snapshot.outbox).toHaveLength(0);
  });

  test('live group reconciliation scopes duplicate keys to sender and does not double-count unread', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    const group = createMockGroup('alice', 'Echo', ['bob', 'carol'], 'echo-group');
    await act(async () => { await resultRef.current.handleSocketConnected(); });
    await act(async () => { socket.receive('conversation.updated', { conversation: group.group, updatedBy: 'alice' }); });
    let key!: string;
    await act(async () => { key = await resultRef.current.sendMessage('echo-group', 'local'); });
    const echo = {
      messageId: 'group-server-local', clientMessageId: key, conversationId: 'echo-group',
      senderId: 'alice', recipientId: 'echo-group', body: 'local', createdAt: '2026-10-03T06:00:00.000Z',
    };
    const other = { ...echo, messageId: 'group-server-other', senderId: 'bob', body: 'other' };
    await act(async () => {
      resultRef.current.handleMessageReceived(echo);
      resultRef.current.handleMessageReceived(other);
      resultRef.current.handleMessageReceived(other);
    });
    expect(resultRef.current.messagesByPeer['echo-group']).toHaveLength(2);
    expect(resultRef.current.messagesByPeer['echo-group'].find((entry: any) => entry.senderId === 'alice'))
      .toMatchObject({ messageId: echo.messageId, clientMessageId: key, syncState: 'synced', pending: false });
    expect(resultRef.current.conversations.find((entry: any) => entry.peerId === 'echo-group').unreadCount).toBe(1);
  });

  test('lost ack then history before retry coalesces sender-scoped identities and resolves pending replies', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef, params } = setup({ socketRef: { current: socket } });
    let key!: string;
    await act(async () => {
      key = await resultRef.current.sendMessage('bob', 'parent');
      await resultRef.current.sendMessage('bob', 'reply', { replyTo: key });
    });
    const parent = {
      messageId: 'history-parent', clientMessageId: key, conversationId: 'alice:bob',
      senderId: 'alice', recipientId: 'bob', body: 'parent', createdAt: '2026-10-03T06:00:00.000Z',
    };
    const other = { ...parent, messageId: 'history-other', senderId: 'bob', recipientId: 'alice', body: 'other sender' };
    let attempts = 0;
    socket.emit.mockImplementation((_event, payload, ack) => {
      attempts += 1;
      if (attempts === 1) ack({ ok: false, error: { message: 'ack lost' } });
      else if (payload.body === 'parent') ack({ ok: true, message: parent });
      else {
        expect(payload.replyTo).toBe(parent.messageId);
        expect((chatDb as any).__snapshot.outbox[0].replyTo).toBe(parent.messageId);
        ack({ ok: true, message: {
          ...parent, ...payload, messageId: 'history-reply', createdAt: '2026-10-03T06:00:01.000Z',
        } });
      }
    });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect((chatDb as any).__snapshot.outbox).toHaveLength(2);
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [other, parent] }) });
    await act(async () => { await resultRef.current.fetchMessagesForPeer('bob'); });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(3);
    expect(resultRef.current.messagesByPeer.bob.filter((entry: any) =>
      entry.senderId === 'alice' && entry.clientMessageId === key)).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob.find((entry: any) => entry.body === 'reply').replyTo).toBe(parent.messageId);
    await drainAtNextDeadline(resultRef);
    expect(attempts).toBe(3);
    expect((chatDb as any).__snapshot.outbox).toHaveLength(0);
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(3);
    expect(resultRef.current.messagesByPeer.bob.find((entry: any) => entry.senderId === 'bob').messageId).toBe(other.messageId);
  });

  test('lost ack replays the same explicit key after a receipt already reconciled the bubble', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    await act(async () => { await resultRef.current.sendMessage('bob', 'ack can be lost'); });
    const key = (chatDb as any).__snapshot.outbox[0].clientMessageId;
    const persisted = {
      messageId: 'persisted-lost-ack', clientMessageId: key, conversationId: 'alice:bob',
      senderId: 'alice', recipientId: 'bob', body: 'ack can be lost',
      createdAt: '2026-10-03T06:00:00.000Z', deliveredTo: ['bob'],
    };
    let attempts = 0;
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.clientMessageId).toBe(key);
      expect(payload.messageId).toBeUndefined();
      attempts += 1;
      if (attempts === 1) {
        resultRef.current.handleMessageDelivered(persisted);
        ack({ ok: false, error: { code: 'timeout', message: 'ack lost' } });
      } else ack({ ok: true, message: persisted });
    });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ clientMessageId: key, attempts: 1 });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0].messageId).toBe(persisted.messageId);
    await drainAtNextDeadline(resultRef);
    expect(attempts).toBe(2);
    expect((chatDb as any).__snapshot.outbox).toHaveLength(0);
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ messageId: persisted.messageId, clientMessageId: key });
  });

  test('offline optimistic replies emit their parent server id, persisted before the reply send', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    let parentKey!: string;
    await act(async () => {
      parentKey = await resultRef.current.sendMessage('bob', 'parent');
      await resultRef.current.sendMessage('bob', 'reply', { replyTo: parentKey });
    });
    const payloads: any[] = [];
    socket.emit.mockImplementation((_event, payload, ack) => {
      payloads.push(payload);
      if (payload.body === 'reply') {
        expect(payload.replyTo).toBe('server-parent');
        expect((chatDb as any).__snapshot.outbox[0].replyTo).toBe('server-parent');
      }
      ack({ ok: true, message: {
        ...payload, messageId: `server-${payload.body}`, conversationId: 'alice:bob',
        senderId: 'alice', recipientId: 'bob', createdAt: '2026-10-03T06:00:00.000Z',
      } });
    });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(payloads).toHaveLength(2);
    expect(payloads[0].clientMessageId).toBe(parentKey);
    expect(payloads[1].clientMessageId).not.toBe(parentKey);
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(2);
    expect(resultRef.current.messagesByPeer.bob.find((message: any) => message.body === 'reply').replyTo).toBe('server-parent');
    expect((chatDb as any).__snapshot.outbox).toHaveLength(0);
  });

  test('uploaded group sends retain explicit keys and the group target', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    const group = createMockGroup('alice', 'Upload', ['bob', 'carol'], 'upload-group');
    await act(async () => { await resultRef.current.handleSocketConnected(); });
    await act(async () => { socket.receive('conversation.updated', { conversation: group.group, updatedBy: 'alice' }); });
    let key!: string;
    await act(async () => {
      key = resultRef.current.beginAttachmentUpload('upload-group', 'image', { url: 'file://preview.jpg' });
      await resultRef.current.finishAttachmentUpload('upload-group', key, 'image',
        { url: 'chatblobs/group_upload-group/group.jpg', mimeType: 'image/jpeg', sizeBytes: 123 });
    });
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ clientMessageId: key, targetKind: 'group', conversationId: 'upload-group' });
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(socket.emit).toHaveBeenCalledWith('message.send', expect.objectContaining({
      conversationId: 'upload-group', clientMessageId: key, type: 'image',
    }), expect.any(Function));
    expect(socket.emit.mock.calls[0][1]).not.toHaveProperty('recipientId');
  });

  test('mock group calls use frozen participant snapshots and never emit peer or group wire events', async () => {
    const { resultRef, params } = setup({ socketRef: { current: makeSocket({ connected: false }) } });
    let id!: string;
    await act(async () => {
      id = await resultRef.current.groupActions.create('Team', ['bob', 'carol']);
      await resultRef.current.groupCallActions.start(id, 'video');
      await resultRef.current.groupCallActions.simulate(id, 'bob', 'accept');
      await resultRef.current.groupCallActions.simulate(id, 'carol', 'decline');
      await resultRef.current.groupCallActions.simulate(id, 'bob', 'leave');
      await resultRef.current.groupCallActions.transition(id, 'leave');
    });
    const snapshot = resultRef.current.groupCalls[id];
    expect(snapshot.call).toMatchObject({ mediaType: 'video', status: 'ended', stateVersion: 5 });
    expect(snapshot.participants.map((person: any) => person.status)).toEqual(['left', 'left', 'declined']);
    expect(snapshot.participants.every((person: any) => person.callId === snapshot.callId && person.invitedAt)).toBe(true);
    expect(params.socketRef.current.emit).not.toHaveBeenCalled();
  });

  test('remote group lifecycle sends exact call requests and consumes authoritative versioned snapshots', async () => {
    const { resultRef, params } = setup();
    const row = createMockGroup('alice', 'Remote', ['bob', 'carol'], 'remote-group');
    let serverSnapshot = startMockGroupCall(row, 'alice', 'remote-call', 'video', '2026-10-03T06:00:00Z');
    params.socketRef.current.emit.mockImplementation((event: string, _payload: object, ack: Function) => {
      const action = event.split('.').pop();
      if (action !== 'start') {
        serverSnapshot = transitionMockGroupCall(serverSnapshot, 'alice', action as 'accept' | 'decline' | 'leave',
          '2026-10-03T06:01:00Z');
      }
      ack({ ok: true, version: 2, call: serverSnapshot.call, participants: serverSnapshot.participants });
    });
    await act(async () => { resultRef.current.handleSocketConnected(); });
    await act(async () => {
      params.socketRef.current.receive('conversation.updated', { conversation: row.group, updatedBy: 'alice' });
      await resultRef.current.groupCallActions.start('remote-group', 'video');
    });
    expect(resultRef.current.groupCalls['remote-group'].participants[0].status).toBe('accepted');
    await act(async () => { await resultRef.current.groupCallActions.transition('remote-group', 'leave'); });
    let snapshot = startMockGroupCall(row, 'bob', 'remote-incoming', 'video', '2026-10-03T06:00:00Z');
    serverSnapshot = snapshot;
    await act(async () => {
      params.socketRef.current.receive('conversation.call.updated', snapshot);
      await resultRef.current.groupCallActions.transition('remote-group', 'accept');
    });
    expect(resultRef.current.groupCalls['remote-group'].participants[0].status).toBe('accepted');
    snapshot = transitionMockGroupCall(snapshot, 'alice', 'accept', '2026-10-03T06:01:00Z');
    await act(async () => {
      params.socketRef.current.receive('conversation.call.updated', snapshot);
      params.socketRef.current.receive('conversation.call.updated', { ...snapshot, call: { ...snapshot.call, stateVersion: 1 } });
      params.socketRef.current.receive('conversation.call.updated', { ...snapshot, callId: 'mismatch' });
      await resultRef.current.groupCallActions.transition('remote-group', 'leave');
    });
    expect(resultRef.current.groupCalls['remote-group'].call.stateVersion).toBe(3);
    const nextCall = startMockGroupCall(row, 'bob', 'remote-call-next', 'audio', '2026-10-03T06:02:00Z');
    serverSnapshot = nextCall;
    await act(async () => {
      params.socketRef.current.receive('conversation.call.updated', nextCall);
      params.socketRef.current.receive('conversation.call.updated', { ...snapshot, call: { ...snapshot.call, stateVersion: 100 } });
      await resultRef.current.groupCallActions.transition('remote-group', 'decline');
    });
    expect(resultRef.current.groupCalls['remote-group'].callId).toBe('remote-call-next');
    expect(params.socketRef.current.emit.mock.calls.map(([event, payload]: any[]) => [event, payload])).toEqual([
      ['conversation.call.start', { version: 2, conversationId: 'remote-group', mediaType: 'video' }],
      ['conversation.call.leave', { version: 2, callId: 'remote-call' }],
      ['conversation.call.accept', { version: 2, callId: 'remote-incoming' }],
      ['conversation.call.leave', { version: 2, callId: 'remote-incoming' }],
      ['conversation.call.decline', { version: 2, callId: 'remote-call-next' }],
    ]);
    await expect(resultRef.current.groupCallActions.simulate('remote-group', 'bob', 'leave')).rejects.toThrow('local preview');
    params.socketRef.current.connected = false;
    await expect(resultRef.current.groupCallActions.transition('remote-group', 'decline')).rejects.toThrow('Connect');
  });

  test('live mode creates, discovers, pages, sends, renames and leaves with actual server wire and REST shapes', async () => {
    const { resultRef, params } = setup({ groupTransport: 'live' });
    let group = createMockGroup('alice', 'Team', ['bob', 'carol'], 'server-group').group!;
    params.socketRef.current.emit.mockImplementation((event: string, payload: any, ack: Function) => {
      if (event === 'conversation.update') group = {
        ...group, name: payload.name, membershipVersion: group.membershipVersion + 1,
      };
      if (event === 'conversation.member.add') group = {
        ...group, memberIds: [...group.memberIds, ...payload.userIds], membershipVersion: group.membershipVersion + 1,
      };
      if (event === 'conversation.member.remove') group = {
        ...group, memberIds: group.memberIds.filter(memberId => memberId !== payload.userId),
        membershipVersion: group.membershipVersion + 1,
      };
      if (event === 'conversation.leave') group = {
        ...group, memberIds: ['bob', 'carol'], membershipVersion: group.membershipVersion + 1,
      };
      if (event === 'message.send') {
        ack({ ok: true, version: 2, message: {
          messageId: 'server-group-send', clientMessageId: payload.clientMessageId,
          conversationId: group.conversationId, senderId: 'alice',
          recipientId: group.conversationId, body: payload.body, createdAt: '2026-10-03T06:01:00Z',
        } });
      } else ack({ ok: true, version: 2, conversation: group });
    });
    let id!: string;
    await act(async () => { id = await resultRef.current.groupActions.create(' Team ', ['alice', 'bob', 'bob', 'carol']); });
    expect(id).toBe('server-group');
    expect(resultRef.current.groupActions.mode).toBe('live');
    expect(resultRef.current.conversations[0]).toMatchObject({ peerId: id, group, localMock: false });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true, json: async () => ({
      conversations: [{ peerId: 'dave', unreadCount: 2 }], groupConversations: [group],
    }) });
    await act(async () => { await resultRef.current.fetchConversations(); });
    expect(resultRef.current.conversations).toHaveLength(2);
    const history = { messageId: 'history-new', conversationId: id, senderId: 'bob', recipientId: id,
      body: 'from server history', createdAt: '2026-10-03T06:00:00Z' };
    params.authedFetchRef.current
      .mockResolvedValueOnce({ ok: true, json: async () => ({ conversationId: id, messages: [history], hasMore: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ ...history, messageId: 'history-old', createdAt: '2026-10-03T05:00:00Z' }] }) });
    await act(async () => {
      await resultRef.current.fetchMessagesForPeer(id);
      await resultRef.current.fetchMessagesForPeer(id, {
        cursor: { before: history.createdAt, beforeType: 'message', beforeMessageId: history.messageId },
      });
    });
    const requests = params.authedFetchRef.current.mock.calls.map(([factory]: any[]) => factory('session-token'));
    expect(requests[1].url).toBe('https://signal.example.com/conversations/server-group/messages?limit=20');
    expect(requests[2].url).toContain('beforeMessageId=history-new');
    expect(requests[2].url).not.toContain('peerId=');
    expect(resultRef.current.messagesByPeer[id].map((message: any) => message.messageId)).toEqual(['history-new', 'history-old']);
    params.socketRef.current.connected = false;
    await act(async () => { await resultRef.current.sendMessage(id, 'durable live send'); });
    const queuedId = (chatDb as any).__snapshot.outbox[0].messageId;
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({ conversationId: id, targetKind: 'group', localMock: false });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [history] }) });
    await act(async () => { await resultRef.current.fetchMessagesForPeer(id); });
    expect(resultRef.current.messagesByPeer[id]).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: queuedId, body: 'durable live send', pending: true }),
    ]));
    expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
    params.socketRef.current.connected = true;
    await act(async () => {
      await resultRef.current.drainOutbox();
      await resultRef.current.groupActions.rename(id, 'Renamed');
      await resultRef.current.groupActions.members(id, { type: 'add', userIds: ['dave'] });
      await resultRef.current.groupActions.members(id, { type: 'remove', userId: 'dave' });
    });
    expect(resultRef.current.conversations.find((row: any) => row.peerId === id).group.name).toBe('Renamed');
    await act(async () => { await resultRef.current.groupActions.leave(id); });
    expect(resultRef.current.conversations.find((row: any) => row.peerId === id))
      .toMatchObject({ group: { membershipVersion: 5, memberIds: ['bob', 'carol'] }, left: true });
    expect(params.socketRef.current.emit.mock.calls.map(([event, payload]: any[]) => [event, payload])).toEqual([
      ['conversation.create', { version: 2, name: 'Team', inviteeIds: ['bob', 'carol'] }],
      ['message.send', { version: 2, conversationId: id, body: 'durable live send', clientMessageId: queuedId }],
      ['conversation.update', { version: 2, conversationId: id, name: 'Renamed' }],
      ['conversation.member.add', { version: 2, conversationId: id, userIds: ['dave'] }],
      ['conversation.member.remove', { version: 2, conversationId: id, userId: 'dave' }],
      ['conversation.leave', { version: 2, conversationId: id }],
    ]);
  });

  test('REST group discovery hydrates groups without peerId and malformed lists do not crash or erase valid rows', async () => {
    const { resultRef, params } = setup();
    const group = createMockGroup('alice', 'Server group', ['bob', 'carol'], 'server-group').group!;
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true, json: async () => ({
      conversations: [{ peerId: 'bob', unreadCount: 1 }], groupConversations: [group],
    }) });
    await act(async () => { await resultRef.current.fetchConversations(); });
    expect(resultRef.current.conversations[0]).toMatchObject({ peerId: 'server-group', group, localMock: false });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true, json: async () => ({
      conversations: [{ peerId: 'bob', unreadCount: 3 }], groupConversations: [{ conversationId: 'bad' }],
    }) });
    await act(async () => { await resultRef.current.fetchConversations(); });
    // The malformed group half is ignored; the direct half of the same response
    // still lands, and the group already known is not erased.
    expect(resultRef.current.conversations).toHaveLength(2);
    expect(resultRef.current.conversations.find((row: any) => row.peerId === 'server-group'))
      .toMatchObject({ group, localMock: false });
    expect(resultRef.current.conversations.find((row: any) => row.peerId === 'bob'))
      .toMatchObject({ unreadCount: 3 });
  });

  test('a group message arriving before REST bootstrap discovers its group without creating a direct thread', async () => {
    const { resultRef, params } = setup();
    const group = createMockGroup('alice', 'Server group', ['bob', 'carol'], 'server-group').group!;
    params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({
      conversations: [], groupConversations: [group],
    }) });
    const message = { messageId: 'early-group-message', conversationId: group.conversationId,
      senderId: 'bob', recipientId: group.conversationId, body: 'early', createdAt: '2026-10-03T06:00:00Z' };
    await act(async () => {
      resultRef.current.handleMessageReceived(message);
      await new Promise(resolve => setImmediate(resolve));
    });
    expect(resultRef.current.conversations).toHaveLength(1);
    expect(resultRef.current.conversations[0]).toMatchObject({ peerId: group.conversationId, unreadCount: 1 });
    expect(resultRef.current.messagesByPeer[group.conversationId])
      .toEqual([{ ...message, createdAt: new Date(message.createdAt).toISOString() }]);
    expect(resultRef.current.messagesByPeer.bob).toBeUndefined();
    expect(params.authedFetchRef.current).toHaveBeenCalledTimes(1);
  });

  test('live lifecycle rejects missing and miscorrelated acknowledgements without synthetic membership changes', async () => {
    const { resultRef, params } = setup({ groupTransport: 'live' });
    await expect(resultRef.current.groupActions.create('Team', ['bob', 'carol'])).rejects.toThrow();
    expect(resultRef.current.conversations).toEqual([]);
    await act(async () => { resultRef.current.handleSocketConnected(); });
    const group = createMockGroup('alice', 'Team', ['bob', 'carol'], 'server-group').group!;
    await act(async () => { params.socketRef.current.receive('conversation.updated', { conversation: group, updatedBy: 'alice' }); });
    params.socketRef.current.emit.mockImplementation((_event: string, _payload: object, ack: Function) => {
      ack({ ok: true, conversation: { ...group, conversationId: 'wrong-group' } });
    });
    await expect(resultRef.current.groupActions.rename('server-group', 'New name')).rejects.toThrow('different group');
    expect(resultRef.current.conversations).toHaveLength(1);
    expect(resultRef.current.conversations[0].group.name).toBe('Team');
  });

  test('live creation is explicitly opt-in and never silently falls back to a mock after a wire/storage failure', async () => {
    const offline = setup({ groupTransport: 'live', socketRef: { current: makeSocket({ connected: false }) } });
    await expect(offline.resultRef.current.groupActions.create('Team', ['bob', 'carol'])).rejects.toThrow('Connect');
    expect(offline.resultRef.current.conversations).toEqual([]);
    const group = createMockGroup('alice', 'Team', ['bob', 'carol'], 'server-group').group!;
    const live = setup({ groupTransport: 'live', socketRef: { current: makeSocket({ ackResponse: { ok: true, conversation: group } }) } });
    await act(async () => { await Promise.resolve(); });
    (chatDb.flushChatDb as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      expect(await live.resultRef.current.groupActions.create('Team', ['bob', 'carol'])).toBe('server-group');
    });
    expect(live.params.updateStatus).toHaveBeenCalledWith(expect.stringContaining('updated on the server'), 'error');
    expect(live.params.socketRef.current.emit).toHaveBeenCalledTimes(1);
    expect(live.resultRef.current.conversations[0].localMock).toBe(false);
  });

  test('local creation cannot return an old account route when the account changes during its durable flush', async () => {
    const { resultRef, params, tree } = setup();
    let finish!: () => void;
    (chatDb.flushChatDb as jest.Mock).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    let creation!: Promise<string>;
    await act(async () => { creation = resultRef.current.groupActions.create('Team', ['bob', 'carol']); });
    act(() => { tree.update(<TestHook resultRef={resultRef} params={{ ...params, userId: 'bob' }} />); });
    await act(async () => {
      finish();
      await expect(creation).rejects.toThrow('Account changed');
    });
  });

  test('group call snapshots and listeners are scoped to the account and reject late callbacks after switching', async () => {
    const { resultRef, params, tree } = setup();
    const row = createMockGroup('alice', 'Remote', ['bob', 'carol'], 'remote-group');
    await act(async () => { resultRef.current.handleSocketConnected(); });
    const oldListener = params.socketRef.current.on.mock.calls.find(([event]: any[]) => event === 'conversation.call.updated')[1];
    const snapshot = startMockGroupCall(row, 'alice', 'remote-call', 'audio', '2026-10-03T06:00:00Z');
    await act(async () => {
      params.socketRef.current.receive('conversation.updated', { conversation: row.group, updatedBy: 'alice' });
      params.socketRef.current.receive('conversation.call.updated', snapshot);
    });
    expect(resultRef.current.groupCalls['remote-group'].callId).toBe('remote-call');
    await act(async () => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, userId: 'bob' }} />);
    });
    act(() => oldListener(snapshot));
    expect(resultRef.current.groupCalls).toEqual({});
    expect(params.socketRef.current.off).toHaveBeenCalledWith('conversation.call.updated', expect.any(Function));
  });

  test('mock group sends queue durably offline, survive remount, then drain locally with the same id', async () => {
    const socket = makeSocket({ connected: false });
    const first = setup({ socketRef: { current: socket } });
    let id!: string;
    await act(async () => {
      id = await first.resultRef.current.groupActions.create('Team', ['bob', 'carol']);
      await first.resultRef.current.sendMessage(id, 'offline group message');
    });
    const item = (chatDb as any).__snapshot.outbox[0];
    expect(item).toMatchObject({ recipientId: id, conversationId: id, targetKind: 'group', localMock: true, attempts: 0 });
    expect(chatDb.flushChatDb).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
    act(() => first.tree.unmount());
    const second = setup({ socketRef: { current: socket } });
    await act(async () => { await Promise.resolve(); });
    expect(second.resultRef.current.messagesByPeer[id][0]).toMatchObject({ messageId: item.messageId, pending: true });
    socket.connected = true;
    await act(async () => {
      second.resultRef.current.handleSocketConnected();
      await second.resultRef.current.drainOutbox();
      await Promise.resolve();
    });
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
    expect(second.resultRef.current.messagesByPeer[id][0]).toMatchObject({ messageId: item.messageId, pending: false });
    expect(second.resultRef.current.messagesByPeer[id]).toHaveLength(1);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('refresh retains local groups beside direct rows and member actions are durable', async () => {
    const { resultRef, params } = setup();
    let id!: string;
    await act(async () => {
      id = await resultRef.current.groupActions.create('Team', ['bob', 'carol']);
      await resultRef.current.groupActions.members(id, { type: 'add', userIds: ['dave'] });
      await resultRef.current.groupActions.members(id, { type: 'remove', userId: 'bob' });
      await resultRef.current.groupActions.rename(id, 'Friends');
    });
    params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({
      conversations: [{ peerId: 'bob', conversationId: 'alice:bob', unreadCount: 2 }],
    }) });
    await act(async () => { await resultRef.current.fetchConversations(); });
    expect(resultRef.current.conversations).toHaveLength(2);
    expect(resultRef.current.conversations[0].group).toMatchObject({ name: 'Friends', memberIds: ['alice', 'carol', 'dave'] });
    expect((chatDb as any).__snapshot.conversations[0].group.name).toBe('Friends');
    expect(resultRef.current.unreadTotal).toBe(2);
    expect(params.socketRef.current.emit).not.toHaveBeenCalled();
  });

  test('leaving stops queued group replay and sending without dropping the failed bubble', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    let id!: string;
    await act(async () => {
      id = await resultRef.current.groupActions.create('Team', ['bob', 'carol']);
      await resultRef.current.sendMessage(id, 'unsent');
      await resultRef.current.groupActions.leave(id);
      await resultRef.current.sendMessage(id, 'must not queue');
    });
    expect(resultRef.current.messagesByPeer[id]).toHaveLength(1);
    expect(resultRef.current.messagesByPeer[id][0].failed).toBe(true);
    expect((chatDb as any).__snapshot.outbox[0].attempts).toBe(5);
    expect((chatDb as any).__snapshot.messagesByPeer[id][0]).toMatchObject({ failed: true, pending: false });
    await act(async () => {
      await resultRef.current.retryMessage(id, resultRef.current.messagesByPeer[id][0].messageId);
    });
    expect((chatDb as any).__snapshot.outbox[0].attempts).toBe(5);
    socket.connected = true;
    await act(async () => { await resultRef.current.drainOutbox(); });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('non-admin membership changes are rejected in the hook', async () => {
    (chatDb as any).__snapshot.conversations = [createMockGroup('bob', 'Team', ['alice', 'carol'], 'mock-group-1')];
    const { resultRef } = setup();
    await act(async () => { await Promise.resolve(); });
    await expect(resultRef.current.groupActions.members('mock-group-1', { type: 'remove', userId: 'carol' }))
      .rejects.toThrow('admin');
    await expect(resultRef.current.groupActions.rename('mock-group-1', 'No')).rejects.toThrow('admin');
  });

  test('authoritative group events route messages, per-member typing/read, and sends by conversation only', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({ changes: [], nextCursor: null, hasMore: false }),
    });
    await act(async () => {
      resultRef.current.handleSocketConnected();
      await Promise.resolve();
      await Promise.resolve();
    });
    const snapshot = createMockGroup('alice', 'Live group', ['bob', 'carol'], 'group-live').group!;
    await act(async () => {
      params.socketRef.current.receive('conversation.updated', { conversation: snapshot, updatedBy: 'alice' });
      resultRef.current.handleMessageReceived({
        messageId: 'incoming', conversationId: 'group-live', senderId: 'bob', recipientId: 'alice',
        body: 'hello group', createdAt: '2026-10-03T01:00:00Z',
      });
      resultRef.current.handleMessageReceived({
        messageId: 'incoming', conversationId: 'group-live', senderId: 'bob', recipientId: 'alice',
        body: 'hello group', createdAt: '2026-10-03T01:00:00Z',
      });
      resultRef.current.handleTypingEvent({ conversationId: 'group-live', senderId: 'bob', isTyping: true });
      resultRef.current.handleTypingEvent({ conversationId: 'group-live', senderId: 'carol', isTyping: true });
      resultRef.current.handleMessageRead({ conversationId: 'group-live', readerId: 'carol', readAt: '2026-10-03T02:00:00Z' });
      await resultRef.current.sendMessage('group-live', 'live group send');
      resultRef.current.sendTypingIndicator('group-live', true);
    });
    expect(resultRef.current.conversations[0]).toMatchObject({ peerId: 'group-live', unreadCount: 1, localMock: false });
    expect(resultRef.current.conversations[0].readByMember).toEqual({ carol: '2026-10-03T02:00:00Z' });
    expect(resultRef.current.groupTyping['group-live']).toEqual({ bob: true, carol: true });
    expect(resultRef.current.typingByPeer.bob).toBeUndefined();
    expect(resultRef.current.messagesByPeer['group-live']).toHaveLength(2);
    expect(resultRef.current.messagesByPeer.bob).toBeUndefined();
    const send = params.socketRef.current.emit.mock.calls.find((args: any[]) => args[0] === 'message.send')[1];
    const typing = params.socketRef.current.emit.mock.calls.find((args: any[]) => args[0] === 'message.typing')[1];
    expect(send).toMatchObject({ version: 2, conversationId: 'group-live' });
    expect(send).not.toHaveProperty('recipientId');
    expect(typing).toEqual({ version: 2, conversationId: 'group-live', isTyping: true });
    await act(async () => { await resultRef.current.markConversationRead('group-live'); });
    const requestUrls = params.authedFetchRef.current.mock.calls
      .map(([buildRequest]: any[]) => buildRequest('sess-1').url);
    expect(requestUrls.some((url: string) => url.includes('/messages/read'))).toBe(false);
  });

  test('storage failure prevents mock send completion and keeps the group outbox recoverable', async () => {
    const { resultRef, params } = setup();
    let id!: string;
    await act(async () => { id = await resultRef.current.groupActions.create('Team', ['bob', 'carol']); });
    (chatDb.flushChatDb as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await act(async () => { await resultRef.current.sendMessage(id, 'keep me'); });
    expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
    expect(resultRef.current.messagesByPeer[id][0].pending).toBe(true);
    expect(params.socketRef.current.emit).not.toHaveBeenCalled();
  });

  test('failed group creation rolls back the snapshot so retry does not create duplicate groups', async () => {
    const { resultRef } = setup();
    await act(async () => { await Promise.resolve(); });
    (chatDb.flushChatDb as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      await expect(resultRef.current.groupActions.create('Team', ['bob', 'carol'])).rejects.toThrow('disk full');
    });
    expect(resultRef.current.conversations).toEqual([]);
    expect((chatDb as any).__snapshot.conversations).toEqual([]);
    await act(async () => { await resultRef.current.groupActions.create('Team', ['bob', 'carol']); });
    expect(resultRef.current.conversations).toHaveLength(1);
  });

  test('per-member typing expires independently and old/non-member receipts cannot advance read summaries', async () => {
    jest.useFakeTimers();
    const { resultRef } = setup();
    let id!: string;
    await act(async () => { id = await resultRef.current.groupActions.create('Team', ['bob', 'carol']); });
    act(() => {
      resultRef.current.handleTypingEvent({ conversationId: id, senderId: 'bob', isTyping: true });
      resultRef.current.handleTypingEvent({ conversationId: id, senderId: 'carol', isTyping: true });
      resultRef.current.handleTypingEvent({ conversationId: id, senderId: 'bob', isTyping: false });
      resultRef.current.handleTypingEvent({ conversationId: id, senderId: 'eve', isTyping: true });
      resultRef.current.handleMessageRead({ conversationId: id, readerId: 'bob', readAt: '2026-10-03T03:00:00Z' });
      resultRef.current.handleMessageRead({ conversationId: id, readerId: 'bob', readAt: '2026-10-03T01:00:00Z' });
      resultRef.current.handleMessageRead({ conversationId: id, readerId: 'eve', readAt: '2026-10-03T04:00:00Z' });
    });
    expect(resultRef.current.groupTyping[id]).toEqual({ bob: false, carol: true });
    expect(resultRef.current.conversations[0].readByMember).toEqual({ bob: '2026-10-03T03:00:00Z' });
    act(() => { jest.advanceTimersByTime(6000); });
    expect(resultRef.current.groupTyping[id]).toEqual({ bob: false, carol: false });
    act(() => { mountedTrees.splice(0).forEach((tree: renderer.ReactTestRenderer) => tree.unmount()); });
    jest.useRealTimers();
  });

  test('fetchConversations is a no-op when there is no session', async () => {
    const { resultRef, params } = setup({ sessionIdRef: { current: null } });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
    expect(resultRef.current.conversations).toEqual([]);
  });

  test('fetchConversations populates conversations and unreadTotal on success', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({
        conversations: [
          { conversationId: 'c1', peerId: 'bob', unreadCount: 2 },
          { conversationId: 'c2', peerId: 'carol', unreadCount: 3 },
        ],
      }),
    });

    await act(async () => {
      await resultRef.current.fetchConversations();
    });

    expect(resultRef.current.conversations).toHaveLength(2);
    expect(resultRef.current.unreadTotal).toBe(5);
  });

  test('fetchConversations silently no-ops on a fetch error', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockRejectedValue(new Error('boom'));
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    expect(resultRef.current.conversations).toEqual([]);
  });

  test('fetchMessagesForPeer sets the first page and pages older messages with `before`', async () => {
    const { resultRef, params } = setup();
    (params.authedFetchRef.current as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ messageId: 'm2', createdAt: '2024-01-02' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ messageId: 'm1', createdAt: '2024-01-01' }],
        }),
      });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([
      { messageId: 'm2', createdAt: '2024-01-02' },
    ]);

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob', { before: '2024-01-02' });
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([
      { messageId: 'm2', createdAt: '2024-01-02' },
      { messageId: 'm1', createdAt: '2024-01-01' },
    ]);
  });

  test('fetchMessagesForPeer requests the merged timeline and dedupes call entries', async () => {
    const { resultRef, params } = setup();
    (params.authedFetchRef.current as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ type: 'call', callId: 'c2', createdAt: '2024-01-02' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [
            // The server repeats the cursor entry defensively; it must not
            // appear twice in the merged list.
            { type: 'call', callId: 'c2', createdAt: '2024-01-02' },
            { type: 'text', messageId: 'm1', createdAt: '2024-01-01' },
          ],
        }),
      });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });
    const request = params.authedFetchRef.current.mock.calls[0][0]('session-1');
    expect(request.url).toContain('include=calls');

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob', { before: '2024-01-02' });
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([
      { type: 'call', callId: 'c2', createdAt: '2024-01-02' },
      { type: 'text', messageId: 'm1', createdAt: '2024-01-01' },
    ]);
  });

  test('fetchMessagesForPeer reconciles by clientMessageId, replacing an optimistic entry', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef, params } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'sent while offline');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    // The server page contains the server's copy of that same message, plus one
    // the client has never seen, and a still-queued local message it cannot
    // know about yet.
    await act(async () => {
      await resultRef.current.sendMessage('bob', 'still queued');
    });
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [
          {
            messageId: 'server-persisted', clientMessageId: messageId,
            body: 'sent while offline',
            senderId: 'alice',
            createdAt: '2024-01-02T00:00:00.000Z',
          },
          { messageId: 'server-1', body: 'hello', createdAt: '2024-01-01T00:00:00.000Z' },
        ],
      }),
    });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });

    const bodies = resultRef.current.messagesByPeer.bob.map((m: any) => m.body);
    expect(bodies).toContain('still queued');
    // Replaced, never duplicated.
    expect(bodies.filter((body: any) => body === 'sent while offline')).toHaveLength(1);
    expect(bodies).toContain('hello');
  });

  test('fetchMessagesForPeer resolves to an empty array with no session or peerId', async () => {
    const { resultRef } = setup({ sessionIdRef: { current: null } });
    let messages;
    await act(async () => {
      messages = await resultRef.current.fetchMessagesForPeer('bob');
    });
    expect(messages).toEqual([]);
  });

  test('markConversationRead posts to /messages/read and zeroes the local unread count', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({ ok: true });
    act(() => {
      resultRef.current.setActiveChatPeerId(null);
    });
    // Seed a conversation via fetchConversations first.
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 4 }],
      }),
    });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true });

    await act(async () => {
      await resultRef.current.markConversationRead('bob');
    });

    expect(resultRef.current.conversations[0].unreadCount).toBe(0);
  });

  test('a live message preserves a queued mark-read update before React renders', async () => {
    (chatDb as any).__snapshot.conversations = [
      { conversationId: 'c1', peerId: 'bob', unreadCount: 4 },
    ];
    const { resultRef, params } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true });

    await act(async () => {
      await resultRef.current.markConversationRead('bob');
      resultRef.current.handleMessageReceived({
        messageId: 'after-read', conversationId: 'c1', senderId: 'bob', body: 'new message',
        createdAt: '2026-10-03T07:00:00.000Z',
      });
    });

    expect(resultRef.current.conversations[0].unreadCount).toBe(1);
    expect(resultRef.current.messagesByPeer.bob.map((message: any) => message.messageId))
      .toEqual(['after-read']);
  });

  test('sendMessage queues durably while offline instead of failing', async () => {
    const socketRef = { current: makeSocket({ connected: false }) };
    const { resultRef, params } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });

    // Still pending, not failed: it goes out when connectivity returns.
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      body: 'hi',
      pending: true,
      syncState: 'pending',
    });
    expect(params.updateStatus).not.toHaveBeenCalled();
    // Written to the durable outbox before anything was emitted, so a
    // force-quit here cannot lose the message.
    expect((chatDb as any).__snapshot.outbox).toEqual([
      expect.objectContaining({ body: 'hi', recipientId: 'bob', attempts: 0 }),
    ]);
    expect(resultRef.current.pendingSendCount).toBe(1);
  });

  test('a queued message is sent once when the socket connects, and leaves the outbox', async () => {
    const socket = makeSocket({ connected: false });
    const socketRef = { current: socket };
    const { resultRef } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'from the train');
    });
    const queuedId = (chatDb as any).__snapshot.outbox[0].messageId;

    socket.connected = true;
    await act(async () => {
      resultRef.current.handleSocketConnected();
    });

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(
      'message.send',
      expect.objectContaining({ clientMessageId: queuedId, body: 'from the train' }),
      expect.any(Function),
    );
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ syncState: 'synced' });
  });

  test('a delivered message buzzes so the sender need not watch the screen', async () => {
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });

    expect(triggerHapticUnlessSilent).toHaveBeenCalledWith('messageSent');
  });

  test('a message that is only queued does not claim to have been sent', async () => {
    const socketRef = { current: makeSocket({ connected: false }) };
    const { resultRef } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'from the train');
    });

    expect(triggerHapticUnlessSilent).not.toHaveBeenCalled();
  });

  test('replaying a backlog buzzes once at most, not once per queued message', async () => {
    // A reconnect that flushes five queued sends must not rattle five times.
    (chatDb as any).__snapshot.outbox = [1, 2, 3].map(index => ({
      messageId: `queued-${index}`,
      conversationId: 'c1',
      recipientId: 'bob',
      body: `queued ${index}`,
      createdAt: `2024-01-01T00:0${index}:00.000Z`,
      attempts: 0,
    }));
    setup();

    await act(async () => {});

    expect(triggerHapticUnlessSilent).not.toHaveBeenCalled();
  });

  test('a send queued by a previous run is replayed on mount', async () => {
    (chatDb as any).__snapshot.outbox = [
      {
        messageId: 'queued-1',
        conversationId: 'c1',
        recipientId: 'bob',
        body: 'survived a force quit',
        createdAt: '2024-01-01T00:00:00.000Z',
        attempts: 0,
      },
    ];
    (chatDb as any).__snapshot.messagesByPeer = {
      bob: [
        {
          messageId: 'queued-1',
          senderId: 'alice',
          recipientId: 'bob',
          body: 'survived a force quit',
          createdAt: '2024-01-01T00:00:00.000Z',
          syncState: 'pending',
          pending: true,
        },
      ],
    };
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {});

    expect(socket.emit).toHaveBeenCalledWith(
      'message.send',
      expect.objectContaining({ messageId: 'queued-1' }),
      expect.any(Function),
    );
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('hydrates conversations and history from the local store before any fetch', async () => {
    (chatDb as any).__snapshot.conversations = [{ conversationId: 'c1', peerId: 'bob', unreadCount: 2 }];
    (chatDb as any).__snapshot.messagesByPeer = {
      bob: [{ messageId: 'm1', body: 'cached', createdAt: '2024-01-01T00:00:00.000Z' }],
    };
    const { resultRef, params } = setup({ socketRef: { current: makeSocket({ connected: false }) } });

    await act(async () => {});

    expect(resultRef.current.conversations).toEqual((chatDb as any).__snapshot.conversations);
    expect(resultRef.current.messagesByPeer.bob[0].body).toBe('cached');
    expect(resultRef.current.unreadTotal).toBe(2);
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
  });

  test('a socket event after a history page is queued retains both page and live message', async () => {
    jest.useFakeTimers();
    (chatDb as any).__snapshot.conversations = [
      { conversationId: 'c1', peerId: 'bob', unreadCount: 0 },
    ];
    const { resultRef, params } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    (chatDb.saveChatSnapshot as jest.Mock).mockClear();
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [{
          messageId: 'history', conversationId: 'c1', senderId: 'bob', recipientId: 'alice',
          body: 'from page', createdAt: '2026-10-03T06:00:00.000Z',
        }],
      }),
    });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
      resultRef.current.handleMessageReceived({
        messageId: 'live-after-page', conversationId: 'c1', senderId: 'bob', body: 'live',
        createdAt: '2026-10-03T07:00:00.000Z',
      });
    });

    expect(resultRef.current.messagesByPeer.bob.map((message: any) => message.messageId))
      .toEqual(['live-after-page', 'history']);
    expect(chatDb.saveChatSnapshot).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(750);
    });
    expect(chatDb.saveChatSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = (chatDb.saveChatSnapshot as jest.Mock).mock.calls[0][0];
    expect(snapshot.messagesByPeer.bob.map((message: any) => message.messageId))
      .toEqual(['live-after-page', 'history']);
    expect(snapshot.socketCursors.c1).toEqual({
      messageCreatedAt: '2026-10-03T07:00:00.000Z', messageId: 'live-after-page',
    });
    jest.useRealTimers();
  });

  test('socket messages arriving during cold hydration merge with cached history and advance the cursor', async () => {
    jest.useFakeTimers();
    let resolveLoad!: (value: any) => void;
    (chatDb.loadChatSnapshot as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      resolveLoad = resolve;
    }));
    const { resultRef } = setup();

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'live', conversationId: 'c1', senderId: 'bob', body: 'arrived during hydration',
        createdAt: '2026-10-03T07:00:00.000Z',
      });
    });

    await act(async () => {
      resolveLoad({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 2 }],
        messagesByPeer: {
          bob: [{ messageId: 'cached', conversationId: 'c1', senderId: 'bob', body: 'from disk',
            createdAt: '2026-10-03T06:00:00.000Z' }],
        },
        socketCursors: {},
        outbox: [],
        drafts: {},
      });
      await Promise.resolve();
    });

    expect(resultRef.current.messagesByPeer.bob.map((message: any) => message.messageId))
      .toEqual(['live', 'cached']);
    act(() => {
      jest.advanceTimersByTime(750);
    });
    expect((chatDb as any).__snapshot.socketCursors.c1).toEqual({
      messageCreatedAt: '2026-10-03T07:00:00.000Z', messageId: 'live',
    });
    jest.useRealTimers();
  });

  test('retryMessage re-queues an exhausted send and discardMessage drops it', async () => {
    const socket = makeSocket({ ackResponse: { ok: false, error: { message: 'nope' } } });
    const { resultRef, params } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });
    // Exhaust the automatic retries.
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await drainAtNextDeadline(resultRef);
    }

    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      failed: true,
      syncState: 'failed',
      deliveryState: 'failed',
    });
    const original = { ...(chatDb as any).__snapshot.outbox[0] };
    expect(resultRef.current.pendingSendCount).toBe(0);
    expect(params.updateStatus).toHaveBeenCalledWith('Message failed to send', 'error');

    await act(async () => {
      await resultRef.current.retryMessage('bob', messageId);
    });
    // The retry re-sends the *same* id, so the server upsert cannot duplicate it.
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.send',
      expect.objectContaining({ clientMessageId: messageId }),
      expect.any(Function),
    );
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
    expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({
      messageId: original.messageId, clientMessageId: original.clientMessageId,
      recipientId: original.recipientId, body: original.body,
    });
    expect(resultRef.current.messagesByPeer.bob[0].deliveryState).toBe('queued');
    expect(resultRef.current.pendingSendCount).toBe(1);

    act(() => {
      resultRef.current.discardMessage('bob', messageId);
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([]);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test.each(['direct', 'group'].flatMap(kind =>
    ['server-id', 'original-id', 'client-id'].flatMap(identity =>
      ['retry', 'discard'].map(action => ({ kind, identity, action })))))
  ('$kind $action resolves $identity after history reconciliation without duplicating or orphaning the queue',
    async ({ kind, identity, action }) => {
      const peerId = kind === 'group' ? 'live-group' : 'bob';
      const createdAt = '2026-10-03T06:00:00.000Z';
      if (kind === 'group') {
        const row = createMockGroup('alice', 'Team', ['bob', 'carol'], peerId);
        row.localMock = false;
        (chatDb as any).__snapshot.conversations = [row];
      }
      const original = {
        messageId: 'original-id', clientMessageId: 'client-id', recipientId: peerId,
        body: 'lost ack', createdAt, attempts: 5, state: 'failed',
        lastAttemptAt: createdAt, lastError: 'ack timeout', nextAttemptAt: Date.now() + 60000,
        ...(kind === 'group' ? { conversationId: peerId, targetKind: 'group' } : {}),
      };
      const unrelated = { ...original, recipientId: 'other-peer', messageId: 'other-id' };
      (chatDb as any).__snapshot.outbox = [original, unrelated];
      (chatDb as any).__snapshot.messagesByPeer = { [peerId]: [{
        ...original, senderId: 'alice', pending: true, syncState: 'pending',
      }] };
      const socket = makeSocket({ connected: false, ackResponse: { ok: false, error: { message: 'ack timeout' } } });
      const { resultRef, params } = setup({ socketRef: { current: socket }, groupTransport: 'live' });
      await act(async () => {});
      const confirmed = {
        messageId: 'server-id', clientMessageId: 'client-id', senderId: 'alice', recipientId: peerId,
        body: original.body, createdAt, conversationId: kind === 'group' ? peerId : 'direct-conversation',
        ...(kind === 'group' ? { readBy: ['bob'] } : { readAt: createdAt }),
      };
      params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({ messages: [confirmed] }) });
      await act(async () => { await resultRef.current.fetchMessagesForPeer(peerId); });
      expect(resultRef.current.messagesByPeer[peerId]).toHaveLength(1);
      expect(resultRef.current.messagesByPeer[peerId][0]).toMatchObject({
        messageId: 'server-id', clientMessageId: 'client-id', deliveryState: 'failed',
      });

      if (action === 'retry') {
        await act(async () => { await resultRef.current.retryMessage(peerId, identity); });
        expect((chatDb as any).__snapshot.outbox).toEqual([
          { ...original, attempts: 0, state: 'pending', lastAttemptAt: null, lastError: null, nextAttemptAt: null },
          unrelated,
        ]);
        expect(resultRef.current.messagesByPeer[peerId]).toHaveLength(1);
        // History keeps the server copy synced; the reset outbox owns delivery state.
        expect(resultRef.current.messagesByPeer[peerId][0]).toMatchObject({
          messageId: 'server-id', clientMessageId: 'client-id', pending: false, failed: false,
          syncState: 'synced', deliveryState: 'queued',
        });
        socket.connected = true;
        await act(async () => { await resultRef.current.drainOutbox(); });
        expect(socket.emit).toHaveBeenCalledTimes(1);
        expect(socket.emit).toHaveBeenCalledWith('message.send', expect.objectContaining({
          clientMessageId: 'client-id', body: original.body,
          ...(kind === 'group' ? { conversationId: peerId } : { recipientId: peerId }),
        }), expect.any(Function));
        expect(resultRef.current.messagesByPeer[peerId]).toHaveLength(1);
        expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({
          messageId: 'original-id', clientMessageId: 'client-id', attempts: 1,
        });
      }
      act(() => resultRef.current.discardMessage(peerId, identity));
      expect(resultRef.current.messagesByPeer[peerId]).toEqual([]);
      expect((chatDb as any).__snapshot.outbox).toEqual([unrelated]);
      await act(async () => { await resultRef.current.drainOutbox(); });
      expect((chatDb as any).__snapshot.outbox).toEqual([unrelated]);
    });

  test.each([
    { readBy: ['alice'], expected: 'sent' },
    { readBy: ['outsider'], expected: 'sent' },
    { readBy: ['alice', 'outsider'], expected: 'sent' },
    { readBy: ['alice', 'outsider', 'bob'], expected: 'read' },
  ])('live group history readers $readBy yield $expected without a local read watermark', async ({ readBy, expected }) => {
    const peerId = 'live-group';
    const row = createMockGroup('alice', 'Team', ['bob', 'carol'], peerId);
    row.localMock = false;
    (chatDb as any).__snapshot.conversations = [row];
    const { resultRef, params } = setup({ socketRef: { current: makeSocket({ connected: false }) }, groupTransport: 'live' });
    await act(async () => {});
    params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({ messages: [{
      messageId: 'server-history', conversationId: peerId, recipientId: peerId, senderId: 'alice',
      body: 'persisted readers', createdAt: '2026-10-03T06:00:00Z', readBy,
    }] }) });
    await act(async () => { await resultRef.current.fetchMessagesForPeer(peerId); });
    expect(resultRef.current.conversations[0].readByMember).toBeUndefined();
    expect(resultRef.current.messagesByPeer[peerId][0]).toMatchObject({ readBy, deliveryState: expected });
  });

  test.each(['direct', 'group'])('%s history reconciliation during an active request stays sending until ack', async kind => {
    const peerId = kind === 'group' ? 'live-group' : 'bob';
    if (kind === 'group') {
      const row = createMockGroup('alice', 'Team', ['bob', 'carol'], peerId);
      row.localMock = false;
      (chatDb as any).__snapshot.conversations = [row];
    }
    const socket = makeSocket();
    let acknowledge!: (response: any) => void;
    socket.emit.mockImplementation((_event, _payload, callback) => { acknowledge = callback; });
    const { resultRef, params } = setup({ socketRef: { current: socket }, groupTransport: 'live' });
    await act(async () => {});
    let sending!: Promise<unknown>;
    await act(async () => { sending = resultRef.current.sendMessage(peerId, 'active send'); });
    const original = resultRef.current.messagesByPeer[peerId][0];
    expect(original.deliveryState).toBe('sending');
    expect(acknowledge).toEqual(expect.any(Function));
    const confirmed = {
      messageId: 'server-active', clientMessageId: original.clientMessageId,
      conversationId: kind === 'group' ? peerId : 'alice:bob',
      senderId: 'alice', recipientId: peerId, body: original.body, createdAt: original.createdAt,
    };
    params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({ messages: [confirmed] }) });
    await act(async () => { await resultRef.current.fetchMessagesForPeer(peerId); });
    expect((chatDb as any).__snapshot.outbox).toEqual([
      expect.objectContaining({ messageId: original.messageId, clientMessageId: original.clientMessageId }),
    ]);
    expect(resultRef.current.messagesByPeer[peerId]).toEqual([
      expect.objectContaining({ messageId: 'server-active', deliveryState: 'sending' }),
    ]);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    await act(async () => { acknowledge({ ok: true, message: confirmed }); await sending; });
    expect(resultRef.current.messagesByPeer[peerId]).toEqual([
      expect.objectContaining({ messageId: 'server-active', deliveryState: 'sent' }),
    ]);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test.each(['direct', 'group'])('%s delivery is sending only during the actual request, then uses server receipts', async kind => {
    const peerId = kind === 'group' ? 'live-group' : 'bob';
    if (kind === 'group') {
      const row = createMockGroup('alice', 'Team', ['bob', 'carol'], peerId);
      row.localMock = false;
      (chatDb as any).__snapshot.conversations = [row];
    }
    const socket = makeSocket({ connected: false });
    let acknowledge!: (response: any) => void;
    socket.emit.mockImplementation((_event, _payload, callback) => { acknowledge = callback; });
    const { resultRef } = setup({ socketRef: { current: socket }, groupTransport: 'live' });
    await act(async () => {
      await Promise.resolve();
      resultRef.current.handleSocketDisconnected();
      await resultRef.current.sendMessage(peerId, 'first');
      await resultRef.current.sendMessage(peerId, 'waiting behind first');
    });
    const first = resultRef.current.messagesByPeer[peerId].find((message: any) => message.body === 'first');
    expect(first.deliveryState).toBe('queued');
    expect(resultRef.current.pendingSendCount).toBe(2);
    expect(socket.emit).not.toHaveBeenCalled();
    socket.connected = true;
    await act(async () => { resultRef.current.handleSocketConnected(); await Promise.resolve(); });
    expect(resultRef.current.messagesByPeer[peerId].find((message: any) => message.body === 'first').deliveryState)
      .toBe('sending');
    expect(resultRef.current.messagesByPeer[peerId].find((message: any) => message.body !== 'first').deliveryState)
      .toBe('queued');
    expect((chatDb as any).__snapshot.messagesByPeer[peerId].every((message: any) => !message.deliveryState)).toBe(true);
    const confirmed = { ...first, messageId: 'server-first', pending: false, syncState: 'synced',
      deliveryState: undefined, ...(kind === 'group' ? {
        conversationId: peerId, recipientId: undefined, deliveredTo: ['alice'],
      } : {}) };
    await act(async () => { acknowledge({ ok: true, message: confirmed }); await Promise.resolve(); });
    expect(resultRef.current.messagesByPeer[peerId].find((message: any) => message.messageId === 'server-first').deliveryState)
      .toBe('sent');
    await act(async () => {
      resultRef.current.handleMessageDelivered({ ...confirmed, deliveredTo: ['bob'] });
    });
    expect(resultRef.current.messagesByPeer[peerId].find((message: any) => message.messageId === 'server-first').deliveryState)
      .toBe('delivered');
    if (kind === 'group') {
      act(() => resultRef.current.handleMessageRead({ readerId: 'alice',
        readAt: new Date(Date.now() + 1000).toISOString(), conversationId: peerId }));
      expect(resultRef.current.messagesByPeer[peerId].find((message: any) => message.messageId === 'server-first').deliveryState)
        .toBe('delivered');
    }
    act(() => resultRef.current.handleMessageRead({ readerId: 'bob', readAt: new Date(Date.now() + 1000).toISOString(),
      ...(kind === 'group' ? { conversationId: peerId } : {}) }));
    expect(resultRef.current.messagesByPeer[peerId].find((message: any) => message.messageId === 'server-first').deliveryState)
      .toBe('read');
    socket.connected = false;
    act(() => resultRef.current.handleSocketDisconnected());
    expect(resultRef.current.messagesByPeer[peerId].find((message: any) => message.body !== 'first').deliveryState)
      .toBe('queued');
    await act(async () => { acknowledge({ ok: false, error: { message: 'disconnected' } }); });
    expect(resultRef.current.pendingSendCount).toBe(1);
  });

  test('offline depth excludes terminal outbox failures and failed uploads and reacts to retry/discard', async () => {
    const createdAt = '2026-10-03T06:00:00Z';
    (chatDb as any).__snapshot.outbox = [
      { messageId: 'queued', recipientId: 'bob', state: 'pending', attempts: 0, createdAt },
      { messageId: 'failed', recipientId: 'bob', state: 'failed', attempts: 1, createdAt },
      { messageId: 'exhausted', recipientId: 'bob', attempts: 5, createdAt },
    ];
    (chatDb as any).__snapshot.messagesByPeer = { bob: [
      { messageId: 'queued', senderId: 'alice', pending: true, createdAt },
      { messageId: 'failed', senderId: 'alice', failed: true, createdAt },
      { messageId: 'exhausted', senderId: 'alice', failed: true, createdAt },
      { messageId: 'upload', senderId: 'alice', uploadState: 'failed', failed: true, createdAt },
    ] };
    const { resultRef } = setup({ socketRef: { current: makeSocket({ connected: false }) } });
    await act(async () => { await Promise.resolve(); resultRef.current.handleSocketDisconnected(); });
    expect(resultRef.current.isOffline).toBe(true);
    expect(resultRef.current.pendingSendCount).toBe(1);
    await act(async () => { await resultRef.current.retryMessage('bob', 'failed'); });
    expect(resultRef.current.pendingSendCount).toBe(2);
    expect(resultRef.current.messagesByPeer.bob.find((message: any) => message.messageId === 'failed').deliveryState)
      .toBe('queued');
    act(() => resultRef.current.discardMessage('bob', 'queued'));
    expect(resultRef.current.pendingSendCount).toBe(1);
    act(() => resultRef.current.discardMessage('bob', 'failed'));
    expect(resultRef.current.pendingSendCount).toBe(0);
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(2);
  });

  test('deleteMessage tombstones a sent message on the server and locally', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'oops');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    let deleted;
    await act(async () => {
      deleted = await resultRef.current.deleteMessage('bob', messageId);
    });

    expect(deleted).toBe(true);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.delete',
      expect.objectContaining({ peerId: 'bob', messageId }),
      expect.any(Function),
    );
    // A delete leaves a tombstone rather than a hole, so a reply that quotes
    // the message still resolves to something renderable.
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0].body).toBe('');
    expect(resultRef.current.messagesByPeer.bob[0].deletedAt).toBeTruthy();
    // The cache is an optimisation, never a second copy of the record: the
    // bytes go with the message the user just withdrew.
    expect(evictCachedAttachmentsForMessage).toHaveBeenCalledWith(messageId);
  });

  test('deleteMessage discards a still-queued message without contacting the server', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'never sent');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    await act(async () => {
      await resultRef.current.deleteMessage('bob', messageId);
    });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(resultRef.current.messagesByPeer.bob).toEqual([]);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('deleteMessage reports an error when a sent message cannot be deleted', async () => {
    const socket = makeSocket();
    const { resultRef, params } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'keep me');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    socket.emit = jest.fn((event, payload, callback) =>
      callback({ ok: false, error: { message: 'nope' } }),
    );
    let deleted;
    await act(async () => {
      deleted = await resultRef.current.deleteMessage('bob', messageId);
    });

    expect(deleted).toBe(false);
    expect(params.updateStatus).toHaveBeenCalledWith('Could not delete message', 'error');
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
  });

  test('handleMessageDeleted tombstones a message the peer deleted', () => {
    const { resultRef } = setup();

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);

    act(() => {
      resultRef.current.handleMessageDeleted({
        conversationId: 'c1',
        messageId: 'm-1',
        deletedBy: 'bob',
        message: { messageId: 'm-1', body: '', deletedAt: '2024-01-01T00:00:00.000Z' },
      });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0].body).toBe('');
    expect(resultRef.current.messagesByPeer.bob[0].deletedAt).toBe('2024-01-01T00:00:00.000Z');
    // A deletion the sender performed is honoured on this device too, even
    // though the message is one this user only received.
    expect(evictCachedAttachmentsForMessage).toHaveBeenCalledWith('m-1');
  });

  test('a delete for a message no longer in the timeline still evicts its cached file', () => {
    const { resultRef } = setup();

    act(() => {
      resultRef.current.handleMessageDeleted({ conversationId: 'c1', messageId: 'm-evicted' });
    });

    // Eviction is keyed off the message id, not off a rendered bubble, so a
    // message paged out of memory has its bytes removed all the same.
    expect(resultRef.current.messagesByPeer).toEqual({});
    expect(evictCachedAttachmentsForMessage).toHaveBeenCalledWith('m-evicted');
  });

  test('isOffline follows the socket lifecycle', async () => {
    const { resultRef } = setup();
    expect(resultRef.current.isOffline).toBe(false);

    act(() => {
      resultRef.current.handleSocketDisconnected();
    });
    expect(resultRef.current.isOffline).toBe(true);

    await act(async () => {
      resultRef.current.handleSocketConnected();
    });
    expect(resultRef.current.isOffline).toBe(false);
  });

  test('sendMessage optimistically appends then reconciles with the server-confirmed message on ack', async () => {
    const confirmedMessage = { messageId: 'm-real', body: 'hi', senderId: 'alice' };
    const socketRef = {
      current: makeSocket({ ackResponse: { ok: true, message: confirmedMessage } }),
    };
    const { resultRef } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });

    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      ...confirmedMessage,
      pending: false,
      syncState: 'synced',
    });
    expect(socketRef.current.emit).toHaveBeenCalledWith(
      'message.send',
      {
        version: 2,
        recipientId: 'bob',
        body: 'hi',
        clientMessageId: expect.any(String),
      },
      expect.any(Function),
    );
  });

  test('sendMessage keeps retrying a rejected ack and only fails after the attempt budget', async () => {
    const socketRef = {
      current: makeSocket({ ackResponse: { ok: false, error: { message: 'nope' } } }),
    };
    const { resultRef, params } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });
    // One attempt spent: still pending, still queued.
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ pending: true });
    expect((chatDb as any).__snapshot.outbox[0].attempts).toBe(1);
    expect(params.updateStatus).not.toHaveBeenCalled();

    for (let attempt = 1; attempt < 5; attempt += 1) {
      await drainAtNextDeadline(resultRef);
    }

    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ pending: false, failed: true });
    expect(params.updateStatus).toHaveBeenCalledWith('Message failed to send', 'error');
  });

  test('sendMessage ignores an empty/whitespace-only body', async () => {
    const { resultRef } = setup();
    await act(async () => {
      await resultRef.current.sendMessage('bob', '   ');
    });
    expect(resultRef.current.messagesByPeer.bob).toBeUndefined();
  });

  test('sendTypingIndicator emits message.typing and throttles repeated true calls per peer', () => {
    jest.useFakeTimers();
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).toHaveBeenCalledTimes(1);

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(2000);
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('sendTypingIndicator always emits isTyping:false immediately, bypassing the throttle', () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
      resultRef.current.sendTypingIndicator('bob', false);
    });
    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenLastCalledWith('message.typing', {
      version: 2,
      recipientId: 'bob',
      isTyping: false,
    });
  });

  test('sendTypingIndicator is a no-op when there is no connected socket', () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('handleMessageReceived bumps unreadCount for an existing conversation when it is not the active chat', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 0 }],
      }),
    });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });

    act(() => {
      resultRef.current.handleMessageReceived({ messageId: 'm1', senderId: 'bob', body: 'hi' });
    });

    expect(resultRef.current.messagesByPeer.bob[0]).toEqual({
      messageId: 'm1',
      senderId: 'bob',
      body: 'hi',
      syncState: 'synced',
    });
    expect(resultRef.current.conversations[0].unreadCount).toBe(1);
    expect(displayMessageReceivedInApp).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', senderId: 'bob', body: 'hi' }),
    );
    expect(markMessageSeen).toHaveBeenCalledWith('m1');
  });

  test('a replayed message after socket reconnect preserves one persisted row and one unread increment', async () => {
    const { resultRef } = setup();
    await act(async () => {
      resultRef.current.handleMessageReceived({
        messageId: 'replayed', conversationId: 'c1', senderId: 'bob', body: 'once',
        createdAt: '2026-10-03T07:00:00.000Z',
      });
      resultRef.current.handleSocketDisconnected();
      resultRef.current.handleSocketConnected();
      resultRef.current.handleMessageReceived({
        messageId: 'replayed', conversationId: 'c1', senderId: 'bob', body: 'once',
        createdAt: '2026-10-03T07:00:00.000Z',
      });
    });

    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.conversations[0].unreadCount).toBe(1);
    expect((chatDb as any).__snapshot.messagesByPeer.bob).toHaveLength(1);
    expect((chatDb as any).__snapshot.conversations[0].unreadCount).toBe(1);
    expect((chatDb as any).__snapshot.socketCursors.c1).toEqual({
      messageCreatedAt: '2026-10-03T07:00:00.000Z', messageId: 'replayed',
    });
  });

  test('handleMessageReceived auto-marks-read and does not bump unread when the conversation is active', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 0 }],
      }),
    });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      resultRef.current.setActiveChatPeerId('bob');
    });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true });

    await act(async () => {
      resultRef.current.handleMessageReceived({ messageId: 'm1', senderId: 'bob', body: 'hi' });
      await Promise.resolve();
    });

    expect(resultRef.current.conversations[0].unreadCount).toBe(0);
    expect(displayMessageReceivedInApp).not.toHaveBeenCalled();
    expect(markMessageSeen).toHaveBeenCalledWith('m1');
  });

  test('handleMessageReceived keeps a provisional new conversation visible when its refetch fails', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockRejectedValue(new Error('offline'));

    await act(async () => {
      resultRef.current.handleMessageReceived({
        conversationId: 'c-new',
        messageId: 'm1',
        senderId: 'newpeer',
        body: 'hi',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(params.authedFetchRef.current).toHaveBeenCalled();
    expect(resultRef.current.conversations).toEqual([
      expect.objectContaining({
        conversationId: 'c-new',
        peerId: 'newpeer',
        unreadCount: 1,
        lastMessage: expect.objectContaining({ messageId: 'm1' }),
      }),
    ]);
  });

  test('handleMessageDelivered appends to the outgoing peer thread, deduping by messageId', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageDelivered({ messageId: 'm1', recipientId: 'bob' });
      resultRef.current.handleMessageDelivered({ messageId: 'm1', recipientId: 'bob' });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
  });

  test('handleMessageDelivered merges a delivery receipt into the message already held', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageDelivered({
        messageId: 'm1',
        recipientId: 'bob',
        deliveredTo: [],
      });
    });
    act(() => {
      resultRef.current.handleMessageDelivered({
        messageId: 'm1',
        recipientId: 'bob',
        deliveredTo: ['bob'],
      });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0].deliveredTo).toEqual(['bob']);
  });

  test('handleMessageRead marks own sent messages to that peer as read', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageDelivered({
        messageId: 'm1',
        recipientId: 'bob',
        senderId: 'alice',
        readAt: null,
      });
    });
    act(() => {
      resultRef.current.handleMessageRead({ readerId: 'bob', readAt: '2024-01-01T00:00:00Z' });
    });
    expect(resultRef.current.messagesByPeer.bob[0].readAt).toBe('2024-01-01T00:00:00Z');
  });

  test('handleMessageRead is a no-op when there is no readerId', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageRead({ readerId: undefined });
    });
    expect(resultRef.current.messagesByPeer).toEqual({});
  });

  test('handleTypingEvent sets typingByPeer and auto-clears after the safety timeout', () => {
    jest.useFakeTimers();
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: true });
    });
    expect(resultRef.current.typingByPeer.bob).toBe(true);

    act(() => {
      jest.advanceTimersByTime(6000);
    });
    expect(resultRef.current.typingByPeer.bob).toBe(false);
    jest.useRealTimers();
  });

  test('handleTypingEvent with isTyping:false clears the indicator immediately', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: true });
    });
    expect(resultRef.current.typingByPeer.bob).toBe(true);
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: false });
    });
    expect(resultRef.current.typingByPeer.bob).toBe(false);
  });

  test('resetTypingState clears pending safety-net timers', () => {
    jest.useFakeTimers();
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: true });
    });
    act(() => {
      resultRef.current.resetTypingState();
    });
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    // Still true: the safety-net timer that would have cleared it was reset.
    expect(resultRef.current.typingByPeer.bob).toBe(true);
    jest.useRealTimers();
  });
});

describe('useMessaging push-notification coordination', () => {
  test('mirrors the open conversation into the push layer and clears its notification', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 0 }],
      }),
    });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });

    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      resultRef.current.setActiveChatPeerId('bob');
      await Promise.resolve();
    });

    expect(setActiveConversation).toHaveBeenCalledWith({
      peerId: 'bob',
      conversationId: 'c1',
    });
    expect(dismissMessageNotification).toHaveBeenCalledWith('c1');

    await act(async () => {
      resultRef.current.setActiveChatPeerId(null);
      await Promise.resolve();
    });
    expect(setActiveConversation).toHaveBeenLastCalledWith(null);
  });

  test('handleMessageReceived marks the message seen so its push does not notify', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
    });
    expect(markMessageSeen).toHaveBeenCalledWith('m1');
  });

  test('handleMessageReceived dismisses the notification for the open conversation', async () => {
    const { resultRef, params } = setup();
    act(() => {
      resultRef.current.setActiveChatPeerId('bob');
    });
    params.authedFetchRef.current.mockResolvedValue({ ok: true });

    await act(async () => {
      resultRef.current.handleMessageReceived({
        messageId: 'm1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
      await Promise.resolve();
    });

    expect(dismissMessageNotification).toHaveBeenCalledWith('c1');
  });
});

describe('useMessaging searchMessages', () => {
  test('queries the search endpoint and returns the results', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ messageId: 'm1', peerId: 'bob', body: 'hello bob' }] }),
    });

    let results;
    await act(async () => {
      results = await resultRef.current.searchMessages('bob', { limit: 5 });
    });

    expect(results).toEqual([{ messageId: 'm1', peerId: 'bob', body: 'hello bob' }]);
    const request = params.authedFetchRef.current.mock.calls[0][0]('sess-1');
    expect(request.url).toContain('/messages/search?');
    expect(request.url).toContain('q=bob');
    expect(request.url).toContain('limit=5');
  });

  test('passes the abort signal through so a stale query can be cancelled', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({}) });
    const controller = new AbortController();

    await act(async () => {
      await resultRef.current.searchMessages('bob', { signal: controller.signal });
    });

    const request = params.authedFetchRef.current.mock.calls[0][0]('sess-1');
    expect(request.options).toEqual({
      headers: { Authorization: 'Bearer sess-1' },
      signal: controller.signal,
    });
  });

  test('returns merged local and server matches, scoped to one conversation', async () => {
    (chatDb as any).__snapshot.messagesByPeer = {
      bob: [{
        messageId: 'cached-hit',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'needle in cache',
        createdAt: '2024-01-01T00:00:00.000Z',
      }],
    };
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          messageId: 'remote-hit',
          peerId: 'bob',
          body: 'needle on server',
          createdAt: '2024-01-02T00:00:00.000Z',
        }],
      }),
    });

    let results: any;
    await act(async () => {
      await Promise.resolve();
      results = await resultRef.current.searchMessages('needle', {
        peerId: 'bob',
        conversationId: 'conversation-bob',
      });
    });

    expect(results.map((message: any) => message.messageId)).toEqual(['remote-hit', 'cached-hit']);
    const request = params.authedFetchRef.current.mock.calls[0][0]('sess-1');
    expect(request.url).toContain('conversationId=conversation-bob');
  });

  test('local message search reads the cache without making a request', async () => {
    (chatDb as any).__snapshot.messagesByPeer = {
      bob: [
        { messageId: 'hit', senderId: 'alice', recipientId: 'bob', body: 'needle here', createdAt: '2024-01-01' },
        { messageId: 'deleted', senderId: 'alice', recipientId: 'bob', body: 'needle gone', deletedAt: '2024-01-02' },
      ],
    };
    const { resultRef, params } = setup();
    let results: any;
    await act(async () => {
      await Promise.resolve();
      results = resultRef.current.searchLocalMessages('needle', { peerId: 'bob' });
    });

    expect(results.map((message: any) => message.messageId)).toEqual(['hit']);
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
  });

  test('backfill resumes from its stored sync cursor and persists each completed page', async () => {
    (resourceCache.readResource as jest.Mock).mockResolvedValue({
      value: {
        since: '1970-01-01T00:00:00.000Z',
        cursor: 'resume-here',
        complete: false,
        messagesSynced: 4,
      },
      updatedAt: 1,
    });
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockImplementation(async (buildRequest: Function) => {
      const request = buildRequest('sess-1');
      expect(request.url).toContain('cursor=resume-here');
      return {
        ok: true,
        json: async () => ({
          changes: [{
            type: 'new',
            message: {
              messageId: 'backfilled',
              senderId: 'bob',
              recipientId: 'alice',
              body: 'history',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          }],
          nextCursor: null,
          hasMore: false,
        }),
      };
    });

    await act(async () => {
      await resultRef.current.backfillMessages();
    });

    expect((chatDb as any).__snapshot.messagesByPeer.bob[0].messageId).toBe('backfilled');
    expect(resourceCache.writeResource).toHaveBeenCalledWith(
      expect.any(String),
      'messages:backfill',
      expect.objectContaining({ cursor: null, complete: true, messagesSynced: 5 }),
    );
    expect(resultRef.current.isBackfillingMessages).toBe(false);
  });

  test('starts history backfill when the authenticated socket connects', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({ changes: [], nextCursor: null, hasMore: false }),
    });

    await act(async () => {
      resultRef.current.handleSocketConnected();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(params.authedFetchRef.current).toHaveBeenCalledTimes(1);
    expect(params.authedFetchRef.current.mock.calls[0][0]('sess-1').url)
      .toContain('/messages/sync?');
    expect(resourceCache.writeResource).toHaveBeenCalledWith(
      expect.any(String),
      'messages:backfill',
      expect.objectContaining({ complete: true }),
    );
  });

  test('reconnect runs a delta sync per direct conversation from its stored cursor without duplicating a pending send', async () => {
    (chatDb as any).__snapshot.conversations = [{ conversationId: 'alice:bob', peerId: 'bob', unreadCount: 0 }];
    (chatDb as any).__snapshot.outbox = [{
      messageId: 'client-1', clientMessageId: 'client-1', recipientId: 'bob', body: 'queued',
      createdAt: '2024-01-05T00:00:00.000Z', attempts: 0, state: 'pending',
    }];
    (resourceCache.readResource as jest.Mock).mockImplementation(async (_scope: string, key: string) =>
      key === 'messages:delta:bob' ? { value: 'stored-cursor', updatedAt: 1 } : null);
    const { resultRef, params } = setup({ socketRef: { current: makeSocket({ connected: false }) } });
    await act(async () => { await Promise.resolve(); });
    params.authedFetchRef.current.mockImplementation(async (buildRequest: Function) => {
      const { url } = buildRequest('sess-1');
      if (!url.includes('/messages/delta?')) {
        return { ok: true, json: async () => ({ changes: [], nextCursor: null, hasMore: false }) };
      }
      return {
        ok: true,
        json: async () => ({
          conversationId: 'alice:bob',
          changes: [
            { type: 'new', message: { messageId: 'server-1', clientMessageId: 'client-1', senderId: 'alice', recipientId: 'bob', body: 'queued', createdAt: '2024-01-05T00:00:01.000Z' } },
            { type: 'new', message: { messageId: 'missed', senderId: 'bob', recipientId: 'alice', body: 'while offline', createdAt: '2024-01-05T00:00:02.000Z' } },
          ],
          limit: 2, nextCursor: null, hasMore: false, cursor: 'after-reconnect',
        }),
      };
    });

    await act(async () => {
      resultRef.current.handleSocketConnected();
      await resultRef.current.syncConversationDeltas();
    });

    const deltaCall = params.authedFetchRef.current.mock.calls
      .map((call: any[]) => call[0]('sess-1').url)
      .find((url: string) => url.includes('/messages/delta?'));
    expect(deltaCall).toContain('peerId=bob');
    expect(deltaCall).toContain('cursor=stored-cursor');
    const bob = resultRef.current.messagesByPeer.bob;
    expect(bob.filter((entry: any) => entry.clientMessageId === 'client-1')).toHaveLength(1);
    expect(bob.map((entry: any) => entry.messageId)).toEqual(['missed', 'server-1']);
    expect(resourceCache.writeResource).toHaveBeenCalledWith(expect.any(String), 'messages:delta:bob', 'after-reconnect');
  });

  test('returns nothing for a blank term, without calling the server', async () => {
    const { resultRef, params } = setup();
    await act(async () => {
      await expect(resultRef.current.searchMessages('   ')).resolves.toEqual([]);
    });
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
  });

  test('degrades to no results when the search request fails', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await expect(resultRef.current.searchMessages('bob')).resolves.toEqual([]);
    });
  });

  test('sendMessage queues an attachment message with its rich fields', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    const attachment = {
      url: 'https://media.test/chatblobs/alice:bob/photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    };
    await act(async () => {
      await resultRef.current.sendMessage('bob', '', { type: 'image', attachment });
    });

    // An attachment message needs no body: the attachment is the content.
    const [queued] = resultRef.current.messagesByPeer.bob;
    expect(queued.type).toBe('image');
    expect(queued.attachment).toEqual(attachment);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.send',
      expect.objectContaining({ type: 'image', attachment }),
      expect.any(Function),
    );
  });

  test('attachment upload helpers keep one message id from preview through retryable send', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });
    const preview = { url: 'file:///photo.jpg', mimeType: 'image/jpeg', sizeBytes: 123 };
    let messageId = '';

    act(() => {
      messageId = resultRef.current.beginAttachmentUpload('bob', 'image', preview) ?? '';
    });
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      messageId,
      attachment: preview,
      uploadState: 'uploading',
      pending: true,
    });
    expect(socket.emit).not.toHaveBeenCalled();

    act(() => {
      resultRef.current.updateAttachmentUploadProgress('bob', messageId, 0.5);
    });
    expect(resultRef.current.messagesByPeer.bob[0].uploadProgress).toBe(0.5);

    const uploaded = { url: 'chatblobs/alice_bob/photo.jpg', mimeType: 'image/jpeg', sizeBytes: 123 };
    await act(async () => {
      await resultRef.current.finishAttachmentUpload('bob', messageId, 'image', uploaded);
    });

    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      messageId,
      attachment: uploaded,
      uploadState: undefined,
    });
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.send',
      expect.objectContaining({ clientMessageId: messageId, type: 'image', attachment: uploaded }),
      expect.any(Function),
    );
  });

  test('a failed attachment upload leaves its bubble retryable instead of removing it', async () => {
    const { resultRef } = setup();
    let messageId = '';

    act(() => {
      messageId = resultRef.current.beginAttachmentUpload('bob', 'image', {
        url: 'file:///photo.jpg',
        mimeType: 'image/jpeg',
      }) ?? '';
      resultRef.current.failAttachmentUpload('bob', messageId, 'Upload cancelled');
    });

    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      messageId,
      pending: false,
      failed: true,
      syncState: 'failed',
      uploadState: 'failed',
      uploadError: 'Upload cancelled',
    });
  });

  test('sendMessage still ignores an empty text message', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', '   ');
    });

    expect(resultRef.current.messagesByPeer.bob).toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('sendMessage forwards replyTo so a reply quotes the original', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'answering', { replyTo: 'm-original' });
    });

    expect(resultRef.current.messagesByPeer.bob[0].replyTo).toBe('m-original');
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.send',
      expect.objectContaining({ replyTo: 'm-original' }),
      expect.any(Function),
    );
  });

  test('reactToMessage stores the server reaction set', async () => {
    const socket = makeSocket({
      ackResponse: { ok: true, reactions: { '\u{1F44D}': ['alice'] } },
    });
    const { resultRef } = setup({ socketRef: { current: socket } });

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'react to me',
      });
    });

    let reacted;
    await act(async () => {
      reacted = await resultRef.current.reactToMessage('bob', 'm-1', '\u{1F44D}', 'add');
    });

    expect(reacted).toBe(true);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.react',
      expect.objectContaining({
        peerId: 'bob',
        messageId: 'm-1',
        emoji: '\u{1F44D}',
        action: 'add',
      }),
      expect.any(Function),
    );
    expect(resultRef.current.messagesByPeer.bob[0].reactions).toEqual({
      '\u{1F44D}': ['alice'],
    });
  });

  test('handleMessageReaction converges a reaction made on another device', () => {
    const { resultRef } = setup();

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
    });

    act(() => {
      resultRef.current.handleMessageReaction({
        messageId: 'm-1',
        reactions: { '\u{2764}\u{FE0F}': ['alice', 'bob'] },
      });
    });

    expect(resultRef.current.messagesByPeer.bob[0].reactions).toEqual({
      '\u{2764}\u{FE0F}': ['alice', 'bob'],
    });
  });
});

describe('useMessaging snapshot persistence', () => {
  test('coalesces socket events for 750ms and persists history and cursor together', async () => {
    jest.useFakeTimers();
    const { resultRef } = setup();
    // Let the hydration promise settle so the persistence gate is open.
    await act(async () => {
      await Promise.resolve();
    });
    (chatDb.saveChatSnapshot as jest.Mock).mockClear();

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-1', conversationId: 'c1', senderId: 'bob', body: 'one',
        createdAt: '2026-10-03T07:00:00.000Z',
      });
      resultRef.current.handleMessageReceived({
        messageId: 'm-2', conversationId: 'c1', senderId: 'bob', body: 'two',
        createdAt: '2026-10-03T07:00:01.000Z',
      });
      resultRef.current.handleMessageReceived({
        messageId: 'm-3', conversationId: 'c1', senderId: 'bob', body: 'three',
        createdAt: '2026-10-03T07:00:02.000Z',
      });
    });

    expect(chatDb.saveChatSnapshot).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(750);
    });

    expect(chatDb.saveChatSnapshot).toHaveBeenCalledTimes(1);
    const latest = (chatDb.saveChatSnapshot as jest.Mock).mock.calls[0][0];
    expect(latest.messagesByPeer.bob).toHaveLength(3);
    expect(latest.socketCursors.c1).toEqual({
      messageCreatedAt: '2026-10-03T07:00:02.000Z', messageId: 'm-3',
    });
    jest.useRealTimers();
  });

  test('flushes the pending mirror when the app leaves the foreground', async () => {
    jest.useFakeTimers();
    const listeners: any[] = [];
    const spy = jest
      .spyOn(require('react-native').AppState, 'addEventListener')
      .mockImplementation(((_event: string, handler: any) => {
        listeners.push(handler);
        return { remove: jest.fn() };
      }) as any);

    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    (chatDb.saveChatSnapshot as jest.Mock).mockClear();

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-9', conversationId: 'c1', senderId: 'bob', body: 'tail',
      });
    });
    expect(chatDb.saveChatSnapshot).not.toHaveBeenCalled();

    act(() => {
      listeners.forEach(handler => handler('background'));
    });

    expect(chatDb.saveChatSnapshot).toHaveBeenCalledTimes(1);
    expect(chatDb.flushChatDb).toHaveBeenCalled();

    // The debounce timer was cancelled by the flush, so it cannot write again.
    act(() => {
      jest.advanceTimersByTime(750);
    });
    expect(chatDb.saveChatSnapshot).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    jest.useRealTimers();
  });
});

describe('transactional outbox and account lifecycle', () => {
  test('composition returns after the local commit while the acknowledgement remains held', async () => {
    let acknowledge!: (value: unknown) => void;
    let commit!: () => void;
    let committed = false;
    const request = jest.fn(() => {
      expect(committed).toBe(true);
      expect((chatDb as any).__snapshot.outbox[0].body).toBe('held ack');
      expect((chatDb as any).__snapshot.messagesByPeer.bob[0].body).toBe('held ack');
      return new Promise(resolve => { acknowledge = resolve; });
    });
    const { resultRef } = setup({ signalingRef: { current: { request } } });
    (chatDb.flushChatDb as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => {
      commit = () => { committed = true; resolve(); };
    }));
    let returned = false;
    let sending!: Promise<string>;
    await act(async () => {
      sending = resultRef.current.sendMessage('bob', 'held ack').then((id: string) => {
        returned = true;
        return id;
      });
    });
    expect(returned).toBe(false);
    expect(request).not.toHaveBeenCalled();
    let key!: string;
    await act(async () => { commit(); key = await sending; });
    expect(returned).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect((chatDb as any).__snapshot.outbox[0].clientMessageId).toBe(key);
    expect(resultRef.current.messagesByPeer.bob[0].syncState).toBe('pending');
    await act(async () => { acknowledge({ message: null }); });
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('a persisted backoff survives restart, connect, foreground and new composition without gating other peers', async () => {
    jest.useFakeTimers();
    try {
      const request = jest.fn().mockRejectedValueOnce(Object.assign(new Error('slow down'), { code: 'rate_limited' }))
        .mockResolvedValue({ message: null });
      const signaling = { request, on: jest.fn(() => jest.fn()) };
      const first = setup({ signalingRef: { current: signaling } });
      const now = Date.now();
      await act(async () => { await first.resultRef.current.sendMessage('bob', 'head'); });
      const delayed = { ...(chatDb as any).__snapshot.outbox[0] };
      expect(delayed).toMatchObject({ attempts: 1, state: 'pending', lastError: 'slow down' });
      expect(delayed.nextAttemptAt).toBeGreaterThanOrEqual(now + 500);
      expect(delayed.nextAttemptAt).toBeLessThanOrEqual(now + 1000);
      await act(async () => { first.tree.unmount(); });
      const { resultRef } = setup({ signalingRef: { current: signaling } });
      await act(async () => {});
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () => {
        resultRef.current.handleSocketConnected();
        (AppState.addEventListener as jest.Mock).mock.calls
          .filter(([event]) => event === 'change').forEach(([, listener]) => listener('active'));
        await resultRef.current.sendMessage('bob', 'later');
        await resultRef.current.sendMessage('carol', 'independent');
      });
      expect(request.mock.calls.map(([, payload]) => payload.body)).toEqual(['head', 'independent']);
      expect((chatDb as any).__snapshot.outbox[0].nextAttemptAt).toBe(delayed.nextAttemptAt);
      await act(async () => { jest.advanceTimersByTime(delayed.nextAttemptAt - Date.now() - 1); });
      expect(request).toHaveBeenCalledTimes(2);
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(request.mock.calls.map(([, payload]) => payload.body)).toEqual(['head', 'independent', 'head', 'later']);
      expect((chatDb as any).__snapshot.outbox).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each(['blocked', 'forbidden', 'bad_request', 'not_found', 'unauthorized', 'unsupported_version'])(
    'a %s rejection fails once, releases its conversation, and explicit retry preserves identity', async code => {
      jest.useFakeTimers();
      try {
        const socket = makeSocket({ ackResponse: { ok: false, error: { code, message: 'rejected' } } });
        const { resultRef } = setup({ socketRef: { current: socket } });
        let key!: string;
        await act(async () => { key = await resultRef.current.sendMessage('bob', 'terminal'); });
        expect((chatDb as any).__snapshot.outbox[0]).toMatchObject({
          messageId: key, clientMessageId: key, attempts: 1, state: 'failed',
          lastError: 'rejected', nextAttemptAt: null,
        });
        expect(resultRef.current.messagesByPeer.bob[0].syncState).toBe('failed');
        await act(async () => {
          resultRef.current.handleSocketConnected();
          jest.advanceTimersByTime(120_000);
          await resultRef.current.drainOutbox();
        });
        expect(socket.emit).toHaveBeenCalledTimes(1);
        socket.emit.mockImplementation((_event, _payload, ack) => { ack({ ok: true, message: null }); });
        await act(async () => { await resultRef.current.sendMessage('bob', 'after failure'); });
        expect(socket.emit).toHaveBeenCalledTimes(2);
        expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
        await act(async () => { await resultRef.current.retryMessage('bob', key); });
        expect(socket.emit).toHaveBeenLastCalledWith('message.send',
          expect.objectContaining({ clientMessageId: key, body: 'terminal' }), expect.any(Function));
        expect((chatDb as any).__snapshot.outbox).toEqual([]);
        expect(resultRef.current.messagesByPeer.bob.find((entry: any) => entry.clientMessageId === key))
          .toMatchObject({ syncState: 'synced', failed: false });
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test('a stale worker cannot mutate a later session even when the account scope returns to its original value', async () => {
    let rejectOld!: (error: unknown) => void;
    const request = jest.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValue({ message: null });
    const { resultRef, params, tree } = setup({ signalingRef: { current: { request } } });
    await act(async () => { await resultRef.current.sendMessage('bob', 'old session'); });
    expect(request).toHaveBeenCalledTimes(1);
    const resetSnapshot = () => Object.assign((chatDb as any).__snapshot,
      { conversations: [], messagesByPeer: {}, outbox: [], socketCursors: {}, drafts: {} });
    await act(async () => {
      resetSnapshot();
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, userId: 'other' }} />);
    });
    await act(async () => {
      resetSnapshot();
      tree.update(<TestHook resultRef={resultRef} params={params} />);
    });
    await act(async () => { await resultRef.current.sendMessage('carol', 'new session'); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { rejectOld(Object.assign(new Error('old rejection'), { code: 'blocked' })); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([, payload]) => payload.body)).toEqual(['old session', 'new session']);
    expect(resultRef.current.messagesByPeer.bob[0].syncState).toBe('pending');
    expect(resultRef.current.messagesByPeer.carol[0].syncState).toBe('synced');
    expect(params.updateStatus).not.toHaveBeenCalled();
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('scope changes cancel an armed deadline timer', async () => {
    jest.useFakeTimers();
    try {
      (chatDb as any).__snapshot.outbox = [{
        messageId: 'old-delayed', recipientId: 'bob', body: 'old scope', attempts: 1,
        state: 'pending', nextAttemptAt: Date.now() + 5000,
      }];
      const request = jest.fn().mockResolvedValue({ message: null });
      const { resultRef, params, tree } = setup({ signalingRef: { current: { request } } });
      await act(async () => {});
      expect(request).not.toHaveBeenCalled();
      await act(async () => {
        Object.assign((chatDb as any).__snapshot,
          { conversations: [], messagesByPeer: {}, outbox: [], socketCursors: {}, drafts: {} });
        tree.update(<TestHook resultRef={resultRef} params={{ ...params, userId: 'other' }} />);
      });
      await act(async () => { jest.advanceTimersByTime(10_000); });
      expect(request).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not emit until both the optimistic message and outbox are committed', async () => {
    const { resultRef, params } = setup();
    let commit!: () => void;
    (chatDb.flushChatDb as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => { commit = resolve; }));
    let sending!: Promise<void>;
    await act(async () => { sending = resultRef.current.sendMessage('bob', 'durable first'); });
    expect(params.socketRef.current.emit).not.toHaveBeenCalled();
    expect((chatDb as any).__snapshot.outbox).toHaveLength(1);
    expect((chatDb as any).__snapshot.messagesByPeer.bob[0].body).toBe('durable first');
    await act(async () => { commit(); await sending; });
    expect(params.socketRef.current.emit).toHaveBeenCalledTimes(1);
  });

  test('a disk-full error prevents sending without consuming a network retry', async () => {
    const { resultRef, params } = setup();
    (chatDb.flushChatDb as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await act(async () => { await resultRef.current.sendMessage('bob', 'not committed'); });
    expect(params.socketRef.current.emit).not.toHaveBeenCalled();
    expect((chatDb as any).__snapshot.outbox[0].attempts).toBe(0);
    expect(params.updateStatus).toHaveBeenCalledWith(expect.stringContaining('not saved'), 'error');
  });

  test('restores queued bubbles even when process death interrupted the UI mirror', async () => {
    (chatDb as any).__snapshot.outbox = [{ messageId: 'q', recipientId: 'bob', body: 'survived', attempts: 5 }];
    const { resultRef } = setup({ socketRef: { current: makeSocket({ connected: false }) } });
    await act(async () => {});
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      messageId: 'q', body: 'survived', failed: true, syncState: 'failed',
    });
  });

  test('concurrent refresh triggers share one request', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({ conversations: [] }) });
    await act(async () => {
      await Promise.all([resultRef.current.fetchConversations(), resultRef.current.fetchConversations()]);
    });
    expect(params.authedFetchRef.current).toHaveBeenCalledTimes(1);
  });

  test('late conversation results cannot cross an account switch', async () => {
    const { resultRef, params, tree } = setup();
    let response!: (value: unknown) => void;
    params.authedFetchRef.current.mockReturnValueOnce(new Promise(resolve => { response = resolve; }));
    let refreshing!: Promise<void>;
    await act(async () => { refreshing = resultRef.current.fetchConversations(); });
    await act(async () => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, userId: 'other' }} />);
      response({ ok: true, json: async () => ({ conversations: [{ peerId: 'private-peer' }] }) });
      await refreshing;
    });
    expect(resultRef.current.conversations).toEqual([]);
  });

  test('a send queued during an in-flight acknowledgement is drained automatically', async () => {
    jest.useFakeTimers();
    try {
      let acknowledge!: (value: unknown) => void;
      const request = jest.fn()
        .mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }))
        .mockResolvedValue({ message: null });
      const { resultRef } = setup({ signalingRef: { current: { request } } });
      let first!: Promise<void>;
      await act(async () => { first = resultRef.current.sendMessage('bob', 'first'); });
      await act(async () => { await resultRef.current.sendMessage('bob', 'second'); });
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () => { acknowledge({ message: null }); await first; });
      await act(async () => { jest.advanceTimersByTime(1000); });
      expect(request).toHaveBeenCalledTimes(2);
      expect((chatDb as any).__snapshot.outbox).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('late attachment uploads cannot enter another account outbox', async () => {
    const { resultRef, params, tree } = setup();
    const oldFinishUpload = resultRef.current.finishAttachmentUpload;
    await act(async () => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, userId: 'other' }} />);
    });
    await act(async () => {
      await oldFinishUpload('bob', 'old-upload', 'image', { url: 'https://example.test/private-image' });
    });
    expect(resultRef.current.pendingSendCount).toBe(0);
    expect(params.socketRef.current.emit).not.toHaveBeenCalled();
  });
});
