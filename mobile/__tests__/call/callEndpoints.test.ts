/**
 * Direct tests for the call URL builders.
 *
 * The escaping is the reason these live in one module, so it is asserted in one
 * place too.
 */

import {
  buildCallActionUrl,
  buildCallLookupUrl,
} from '../../src/call/callEndpoints';

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

describe('buildCallActionUrl', () => {
  it.each(['accept', 'decline'] as const)('addresses the %s endpoint', action => {
    expect(
      buildCallActionUrl({ signalingUrl: 'https://s.example', callId: 'c1', action }),
    ).toBe(`https://s.example/calls/c1/${action}`);
  });

  it('tolerates a stored URL with surrounding whitespace', () => {
    expect(
      buildCallActionUrl({ signalingUrl: '  https://s.example ', callId: 'c', action: 'accept' }),
    ).toBe('https://s.example/calls/c/accept');
  });

  it('escapes the callId, so a payload cannot reshape the request', () => {
    expect(
      buildCallActionUrl({
        signalingUrl: 'https://s.example',
        callId: '../../admin',
        action: 'decline',
      }),
    ).toBe('https://s.example/calls/..%2F..%2Fadmin/decline');
  });
});
