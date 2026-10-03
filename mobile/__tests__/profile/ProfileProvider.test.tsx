import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ProfileProvider from '../../src/profile/ProfileProvider';
import { useCallSelector } from '../../src/call/CallProvider';
import { installRenderCleanup } from '../../testUtils/renderCleanup';

jest.mock('../../src/call/CallProvider', () => ({ useCallSelector: jest.fn() }));
installRenderCleanup();

test('profile selector contains only scope, transport and block fields, not changing call samples', async () => {
  const callFlow = {
    isRegistered: true, userId: 'self', signalingUrl: 'https://signal.example',
    authedFetch: jest.fn(async () => null), searchUsers: jest.fn(async () => []), blockedUsers: [],
    connectionQuality: 'good', elapsedCallSeconds: 1,
  };
  (useCallSelector as jest.Mock).mockImplementation(select => select({ callFlow }));
  await act(async () => { renderer.create(<ProfileProvider><></></ProfileProvider>); });
  const select = (useCallSelector as jest.Mock).mock.calls[0][0];
  const selected = select({ callFlow });
  expect(Object.keys(selected).sort()).toEqual([
    'authedFetch', 'blockedUsers', 'searchUsers', 'signalingUrl', 'userId',
  ]);
  expect(select({ callFlow: { ...callFlow, connectionQuality: 'poor', elapsedCallSeconds: 2 } })).toEqual(selected);
  expect(select({ callFlow: { ...callFlow, isRegistered: false } }).userId).toBe('');
});
