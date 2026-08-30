/**
 * Direct tests for the push-rehydration and media-state rules.
 *
 * None of this mounts `useCallFlow`: the point of the extraction is that the
 * decisions a push-opened app makes are reachable without a peer connection.
 */

import {
  buildCallLookupUrl,
  classifyLookupFailure,
  describeRehydratedCall,
  isRehydratableCallId,
  readMediaStateFrame,
  shouldDeferRehydration,
} from '../../src/call/pushRehydration';

describe('isRehydratableCallId', () => {
  it.each([
    ['call-1', true],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%p → %p', (callId, expected) => {
    expect(isRehydratableCallId(callId as string | null | undefined)).toBe(expected);
  });
});

describe('shouldDeferRehydration', () => {
  it('proceeds once both an identity and a signaling URL are known', () => {
    expect(
      shouldDeferRehydration({ userId: 'alice', signalingUrl: 'https://s.example' }),
    ).toBe(false);
  });

  it.each([
    ['no userId', { userId: '', signalingUrl: 'https://s.example' }],
    ['whitespace userId', { userId: '   ', signalingUrl: 'https://s.example' }],
    ['null userId', { userId: null, signalingUrl: 'https://s.example' }],
    ['no url', { userId: 'alice', signalingUrl: '' }],
    ['whitespace url', { userId: 'alice', signalingUrl: '  ' }],
    ['neither', { userId: undefined, signalingUrl: undefined }],
  ])('defers when there is %s', (_label, input) => {
    expect(shouldDeferRehydration(input)).toBe(true);
  });
});

describe('buildCallLookupUrl', () => {
  it('asks the signaling host about the call, carrying the session', () => {
    expect(
      buildCallLookupUrl({
        signalingUrl: 'https://s.example',
        callId: 'call-1',
        sessionId: 'sess-1',
      }),
    ).toBe('https://s.example/calls/call-1?sessionId=sess-1');
  });

  it('tolerates a stored URL with surrounding whitespace', () => {
    expect(
      buildCallLookupUrl({
        signalingUrl: '  https://s.example  ',
        callId: 'c',
        sessionId: 's',
      }),
    ).toBe('https://s.example/calls/c?sessionId=s');
  });

  it('escapes both ids, so a payload cannot reshape the request', () => {
    const url = buildCallLookupUrl({
      signalingUrl: 'https://s.example',
      callId: '../admin',
      sessionId: 'a&b=c',
    });
    expect(url).toBe('https://s.example/calls/..%2Fadmin?sessionId=a%26b%3Dc');
  });
});

describe('classifyLookupFailure', () => {
  it('treats a 404 as an answer, not a fault', () => {
    expect(classifyLookupFailure(404)).toEqual({
      outcome: 'not_found',
      message: 'Call no longer available',
    });
  });

  it.each([400, 401, 429, 500, 503])('raises on %d', status => {
    expect(classifyLookupFailure(status)).toEqual({ outcome: 'throw' });
  });
});

describe('describeRehydratedCall', () => {
  it('lets a still-ringing call through to the incoming screen', () => {
    expect(describeRehydratedCall('ringing')).toEqual({ outcome: 'ringing' });
  });

  it.each([
    ['missed', 'Missed call'],
    ['declined', 'Call was declined'],
    ['ended', 'Call ended'],
    ['busy', 'Line was busy'],
    ['unreachable', 'Call unreachable'],
  ])('reports %s as "%s"', (status, message) => {
    expect(describeRehydratedCall(status)).toEqual({ outcome: 'terminal', message });
  });

  it.each([
    ['a status from a newer server', 'transferred'],
    ['a status that is not a string', 42],
    ['a missing status', undefined],
    ['a null status', null],
  ])('falls back to a generic message for %s', (_label, status) => {
    expect(describeRehydratedCall(status)).toEqual({
      outcome: 'terminal',
      message: 'Call no longer active',
    });
  });

  it('never inherits a message from Object.prototype', () => {
    expect(describeRehydratedCall('constructor')).toEqual({
      outcome: 'terminal',
      message: 'Call no longer active',
    });
  });
});

describe('readMediaStateFrame', () => {
  it('reads both flags when the peer sends both', () => {
    expect(readMediaStateFrame({ isScreenSharing: true, isVideoEnabled: false })).toEqual({
      isScreenSharing: true,
      isVideoEnabled: false,
    });
  });

  it('claims nothing when a liveness beat carries no flags', () => {
    expect(readMediaStateFrame({})).toEqual({});
  });

  it('reads each key independently, so silence is not a claim', () => {
    expect(readMediaStateFrame({ isScreenSharing: true })).toEqual({
      isScreenSharing: true,
    });
    expect(readMediaStateFrame({ isVideoEnabled: false })).toEqual({
      isVideoEnabled: false,
    });
  });

  it('reports a present-but-falsy flag rather than dropping it', () => {
    expect(readMediaStateFrame({ isScreenSharing: false, isVideoEnabled: true })).toEqual({
      isScreenSharing: false,
      isVideoEnabled: true,
    });
  });

  it('coerces a sloppy peer\u2019s value to a boolean', () => {
    expect(readMediaStateFrame({ isScreenSharing: 1, isVideoEnabled: null })).toEqual({
      isScreenSharing: true,
      isVideoEnabled: false,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'yes'],
    ['a number', 3],
  ])('claims nothing for %s', (_label, mediaState) => {
    expect(readMediaStateFrame(mediaState)).toEqual({});
  });
});
