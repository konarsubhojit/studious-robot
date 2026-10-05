/**
 * Direct tests for the call URL builders.
 *
 * The escaping is the reason these live in one module, so it is asserted in one
 * place too.
 */

import {
  buildCallActionUrl,
  buildGroupCallLookupUrl,
  buildCallLookupUrl,
} from '../../src/call/callEndpoints';

describe('buildCallLookupUrl', () => {
  it('asks the signaling host about the call', () => {
    expect(
      buildCallLookupUrl({ signalingUrl: 'https://s.example', callId: 'call-1' }),
    ).toBe('https://s.example/calls/call-1');
  });

  it('tolerates a stored URL with surrounding whitespace', () => {
    expect(
      buildCallLookupUrl({ signalingUrl: '  https://s.example  ', callId: 'c' }),
    ).toBe('https://s.example/calls/c');
  });

  it('normalizes a trailing slash on the signaling base URL', () => {
    expect(buildCallLookupUrl({ signalingUrl: 'https://s.example///', callId: 'c' }))
      .toBe('https://s.example/calls/c');
  });

  it('escapes the callId, so a payload cannot reshape the request', () => {
    const url = buildCallLookupUrl({
      signalingUrl: 'https://s.example',
      callId: '../admin',
    });
    expect(url).toBe('https://s.example/calls/..%2Fadmin');
  });

  describe('buildGroupCallLookupUrl', () => {
    it('uses the authenticated group-call resource path and escapes the call id', () => {
      expect(buildGroupCallLookupUrl({
        signalingUrl: 'https://s.example/',
        callId: '../group-call',
      })).toBe('https://s.example/groups/calls/..%2Fgroup-call');
    });
  });

  // The session id is a bearer token and must never reach a URL, where proxy
  // access logs and request history keep it beyond the app's reach.
  it('never carries the session id', () => {
    const url = buildCallLookupUrl({ signalingUrl: 'https://s.example', callId: 'c' });
    expect(url).not.toContain('sessionId');
    expect(url).not.toContain('?');
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
