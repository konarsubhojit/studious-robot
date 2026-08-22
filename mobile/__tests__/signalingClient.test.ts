// @ts-check
import { createSignalingClient, MAX_QUEUED_EVENTS } from '../src/signalingClient';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../shared';
import { logWarn } from '../src/appLogger';

jest.mock('../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

function makeSocket(
  /** @type {{ connected?: boolean, ack?: any }} */ { connected = true, ack = { ok: true } }: { connected?: boolean; ack?: any; } = {},
) {
  /** @type {Record<string, (payload?: any) => void>} */
  const handlers: Record<string, (payload?: any) => void> = {};
  return {
    connected,
    handlers,
    on: jest.fn((/** @type {string} */ event: string, /** @type {any} */ handler: any) => {
      handlers[event] = handler;
    }),
    emit: jest.fn((/** @type {string} */ event: string, /** @type {any} */ payload: any, /** @type {any} */ callback: any) => {
      if (typeof callback === 'function') callback(ack);
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createSignalingClient inbound validation', () => {
  test('delivers a payload that matches the contract', () => {
    const socket = makeSocket();
    const client = createSignalingClient((socket as any));
    const handler = jest.fn();

    client.on(SERVER_EVENTS.CALL_INCOMING, handler);
    socket.handlers[SERVER_EVENTS.CALL_INCOMING]({
      version: 1,
      call: { callId: 'call-1', callerId: 'bob', calleeId: 'alice', status: 'ringing' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].call.callId).toBe('call-1');
  });

  test('drops and logs a malformed payload instead of calling the handler', () => {
    const socket = makeSocket();
    const client = createSignalingClient((socket as any));
    const handler = jest.fn();

    client.on(SERVER_EVENTS.CALL_INCOMING, handler);
    socket.handlers[SERVER_EVENTS.CALL_INCOMING]({ version: 1 });
    socket.handlers[SERVER_EVENTS.CALL_INCOMING](undefined);

    expect(handler).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      '[Signaling] Dropped malformed inbound event',
      expect.objectContaining({ event: SERVER_EVENTS.CALL_INCOMING }),
    );
  });
});

describe('createSignalingClient outbound validation', () => {
  test('emits a valid payload untouched, preserving object identity', () => {
    const socket = makeSocket();
    const client = createSignalingClient((socket as any));
    const sdp = { type: 'offer', sdp: 'v=0' };

    const sent = client.emit(CLIENT_EVENTS.RTC_OFFER, {
      version: 1,
      callId: 'call-1',
      sdp,
    });

    expect(sent).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith(CLIENT_EVENTS.RTC_OFFER, {
      version: 1,
      callId: 'call-1',
      sdp,
    });
    expect(socket.emit.mock.calls[0][1].sdp).toBe(sdp);
  });

  test('refuses to emit a payload that breaks the contract', () => {
    const socket = makeSocket();
    const client = createSignalingClient((socket as any));

    const sent = client.emit(CLIENT_EVENTS.MESSAGE_SEND, { version: 1, recipientId: 'bob' });

    expect(sent).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      '[Signaling] Refused to emit malformed event',
      expect.objectContaining({ event: CLIENT_EVENTS.MESSAGE_SEND }),
    );
  });

  test('request rejects a malformed payload without touching the socket', async () => {
    const socket = makeSocket();
    const client = createSignalingClient((socket as any));

    await expect(client.request(CLIENT_EVENTS.CALL_INITIATE, { version: 1 })).rejects.toThrow(
      /calleeId/,
    );
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('request resolves with the acknowledgement envelope', async () => {
    const socket = makeSocket({ ack: { ok: true, call: { callId: 'call-9' } } });
    const client = createSignalingClient((socket as any));

    const result = await client.request(CLIENT_EVENTS.CALL_INITIATE, {
      version: 1,
      calleeId: 'bob',
    });

    expect(result.call.callId).toBe('call-9');
  });
});

describe('createSignalingClient offline queue', () => {
  test('queues fire-and-forget events while disconnected and flushes on reconnect', () => {
    const socket = makeSocket({ connected: false });
    const client = createSignalingClient((socket as any));

    const sent = client.emit(CLIENT_EVENTS.MESSAGE_TYPING, {
      version: 1,
      recipientId: 'bob',
      isTyping: true,
    });

    expect(sent).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(client.getQueuedEventCount()).toBe(1);

    socket.connected = true;
    expect(client.flushQueue()).toBe(1);
    expect(socket.emit).toHaveBeenCalledWith(CLIENT_EVENTS.MESSAGE_TYPING, {
      version: 1,
      recipientId: 'bob',
      isTyping: true,
    });
    expect(client.getQueuedEventCount()).toBe(0);
  });

  test('caps the queue, dropping the oldest event once it is full', () => {
    const socket = makeSocket({ connected: false });
    const client = createSignalingClient((socket as any));

    for (let index = 0; index < MAX_QUEUED_EVENTS + 3; index += 1) {
      client.emit(CLIENT_EVENTS.MESSAGE_TYPING, {
        version: 1,
        recipientId: `peer-${index}`,
        isTyping: true,
      });
    }

    expect(client.getQueuedEventCount()).toBe(MAX_QUEUED_EVENTS);
    socket.connected = true;
    client.flushQueue();
    // The three oldest events were dropped, so the first flushed peer is peer-3.
    expect(socket.emit.mock.calls[0][1].recipientId).toBe('peer-3');
  });

  test('an ack-carrying emit is never queued, since its caller is waiting now', () => {
    const socket = makeSocket({ connected: false });
    const client = createSignalingClient((socket as any));
    const ack = jest.fn();

    client.emit(CLIENT_EVENTS.CALL_END, { version: 1, callId: 'call-1' }, ack);

    expect(socket.emit).toHaveBeenCalledWith(
      CLIENT_EVENTS.CALL_END,
      { version: 1, callId: 'call-1' },
      ack,
    );
    expect(client.getQueuedEventCount()).toBe(0);
  });
});
