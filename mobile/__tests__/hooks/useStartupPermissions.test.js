import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useStartupPermissions from '../../src/hooks/useStartupPermissions';

jest.mock('../../src/appLogger', () => ({ logWarn: jest.fn() }));
jest.mock('../../src/permissions', () => ({
  ensureCallPermissions: jest.fn(() => Promise.resolve({ ok: true, warningMessage: null })),
}));

const { logWarn } = require('../../src/appLogger');
const { ensureCallPermissions } = require('../../src/permissions');

function TestHook({ userId }) {
  useStartupPermissions(userId);
  return null;
}

describe('useStartupPermissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not request permissions while no identity is established', async () => {
    await act(async () => {
      renderer.create(<TestHook userId="" />);
    });

    expect(ensureCallPermissions).not.toHaveBeenCalled();
  });

  test('requests permissions once an identity is established', async () => {
    await act(async () => {
      renderer.create(<TestHook userId="alice" />);
    });

    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);
  });

  test('does not re-request on re-render for the same identity', async () => {
    let tree;
    await act(async () => {
      tree = renderer.create(<TestHook userId="alice" />);
    });
    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.update(<TestHook userId="alice" />);
    });

    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);
  });

  test('logs a warning when the permission result carries a warning message', async () => {
    ensureCallPermissions.mockResolvedValueOnce({ ok: true, warningMessage: 'uh oh' });

    await act(async () => {
      renderer.create(<TestHook userId="alice" />);
    });

    expect(logWarn).toHaveBeenCalledWith(
      '[StartupPermissions] Startup permission request',
      { message: 'uh oh' },
    );
  });

  test('logs a warning instead of throwing when the request rejects', async () => {
    ensureCallPermissions.mockRejectedValueOnce(new Error('boom'));

    await act(async () => {
      renderer.create(<TestHook userId="alice" />);
    });

    expect(logWarn).toHaveBeenCalledWith(
      '[StartupPermissions] Startup permission request failed',
      { message: 'boom' },
    );
  });
});
