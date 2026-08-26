import React from 'react';
import renderer, { act } from 'react-test-renderer';
import usePermissionsPrimer from '../../src/hooks/usePermissionsPrimer';

jest.mock('../../src/appLogger', () => ({ logWarn: jest.fn() }));
jest.mock('../../src/permissions', () => ({
  ensureCallPermissions: jest.fn(() => Promise.resolve({ ok: true, warningMessage: null })),
  getMissingRuntimePermissions: jest.fn(() =>
    Promise.resolve(['android.permission.CAMERA']),
  ),
  getCallRuntimePermissions: jest.fn(() => ['android.permission.CAMERA']),
}));
jest.mock('../../src/settingsStorage', () => ({
  loadOnboardingState: jest.fn(() => Promise.resolve({ permissionsPrimerSeen: false })),
  saveOnboardingState: jest.fn(() => Promise.resolve(true)),
}));

const { ensureCallPermissions, getMissingRuntimePermissions } = require('../../src/permissions');
const { loadOnboardingState, saveOnboardingState } = require('../../src/settingsStorage');

let latest: any = null;

function TestHook({ isRegistered }: any) {
  latest = usePermissionsPrimer(isRegistered);
  return null;
}

async function render(isRegistered = true) {
  let tree: any;
  await act(async () => {
    tree = renderer.create(<TestHook isRegistered={isRegistered} />);
  });
  return tree;
}

describe('usePermissionsPrimer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    latest = null;
    (loadOnboardingState as jest.Mock).mockResolvedValue({ permissionsPrimerSeen: false });
    (getMissingRuntimePermissions as jest.Mock).mockResolvedValue([
      'android.permission.CAMERA',
    ]);
  });

  test('shows the primer on a first run with permissions still to ask for', async () => {
    await render();

    expect(latest.isPrimerVisible).toBe(true);
    expect(latest.isPrimerResolved).toBe(true);
  });

  test('never shows over the sign-in screen', async () => {
    await render(false);

    expect(latest.isPrimerVisible).toBe(false);
  });

  test('does not show again once it has been answered', async () => {
    (loadOnboardingState as jest.Mock).mockResolvedValue({ permissionsPrimerSeen: true });

    await render();

    expect(latest.isPrimerVisible).toBe(false);
  });

  test('records an upgrade with nothing left to grant as already answered', async () => {
    (getMissingRuntimePermissions as jest.Mock).mockResolvedValue([]);

    await render();

    // Explaining dialogs that will never appear is noise.
    expect(latest.isPrimerVisible).toBe(false);
    expect(saveOnboardingState).toHaveBeenCalledWith({ permissionsPrimerSeen: true });
  });

  test('accepting requests the permissions and remembers the answer', async () => {
    await render();

    await act(async () => {
      await latest.acceptPrimer();
    });

    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);
    expect(saveOnboardingState).toHaveBeenCalledWith({ permissionsPrimerSeen: true });
    expect(latest.isPrimerVisible).toBe(false);
  });

  test('declining remembers the answer without prompting', async () => {
    await render();

    await act(async () => {
      await latest.skipPrimer();
    });

    // Declining is a real answer: no dialogs now, and no nagging next launch.
    expect(ensureCallPermissions).not.toHaveBeenCalled();
    expect(saveOnboardingState).toHaveBeenCalledWith({ permissionsPrimerSeen: true });
    expect(latest.isPrimerVisible).toBe(false);
  });

  test('a failed permission request still leaves the primer answered', async () => {
    (ensureCallPermissions as jest.Mock).mockRejectedValueOnce(new Error('nope'));

    await render();
    await act(async () => {
      await latest.acceptPrimer();
    });

    expect(latest.isPrimerVisible).toBe(false);
  });

  test('an unreadable first-run flag falls open, showing the explanation again', async () => {
    (loadOnboardingState as jest.Mock).mockRejectedValue(new Error('EACCES'));

    await render();

    // Showing an explanation twice is a smaller failure than never showing it.
    expect(latest.isPrimerVisible).toBe(true);
  });

  test('stays hidden until the persisted answer has been read', async () => {
    let resolveLoad: any;
    (loadOnboardingState as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        resolveLoad = resolve;
      }),
    );

    let tree: any;
    await act(async () => {
      tree = renderer.create(<TestHook isRegistered />);
    });

    // Rendering before the read resolves would flash the primer at people who
    // already answered it.
    expect(latest.isPrimerResolved).toBe(false);
    expect(latest.isPrimerVisible).toBe(false);

    await act(async () => {
      resolveLoad({ permissionsPrimerSeen: true });
    });
    expect(latest.isPrimerVisible).toBe(false);
    await act(async () => {
      tree.unmount();
    });
  });
});
