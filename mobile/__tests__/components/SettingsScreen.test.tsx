import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SettingsScreen from '../../src/components/SettingsScreen';
import ThemeContext, { buildTheme } from '../../src/ThemeContext';

jest.mock(
  '../../src/components/AppButton',
  () => (props: any) => require('react').createElement('AppButton', props),
);

const baseProps: any = {
  userId: 'alice',
  signalingUrl: 'https://signal.example.com',
  onSaveSignalingUrl: jest.fn(),
  onSignOut: jest.fn(),
  onClose: jest.fn(),
  status: { message: '', severity: 'info' },
};

function findByTestID(tree: any, id: any) {
  return tree.root.findAll((n: any) => n.props.testID === id);
}

/** Presses the composite that owns the handler, not its host descendants. */
function pressByTestID(tree: any, id: any) {
  const pressable = tree.root.findAll(
    (n: any) => n.props?.testID === id && typeof n.props?.onPress === 'function',
  )[0];
  act(() => {
    pressable.props.onPress();
  });
}

describe('SettingsScreen', () => {
  afterEach(() => jest.clearAllMocks());

  test('shows the username without offering an editor for it', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });

    // The username is claimed by the account on the signaling server, so an
    // editor here could only ever fail — the row states the value and the rule.
    expect(findByTestID(tree, 'settings-username-input')).toHaveLength(0);
    const row = findByTestID(tree, 'settings-username-row')[0];
    expect(row.props.value).toBe('alice');
    expect(row.props.onPress).toBeUndefined();
  });

  test('names the account behind the username', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <SettingsScreen {...baseProps} accountEmail="alice@example.com" accountProviderId="google.com" />,
      );
    });

    const account = findByTestID(tree, 'settings-account').filter(
      (n: any) => typeof n.type === 'string',
    )[0];
    expect(account.props.children).toContain('alice@example.com');
    expect(account.props.children).toContain('Google');
  });

  test('the signaling server is edited in a sheet, not inline', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });

    // Closed by default: an inline input in a settings list invites accidental
    // edits to a value almost nobody should change.
    expect(findByTestID(tree, 'settings-signaling-input')).toHaveLength(0);

    pressByTestID(tree, 'settings-signaling-row');
    const input = findByTestID(tree, 'settings-signaling-input')[0];
    expect(input.props.value).toBe('https://signal.example.com');
  });

  test('Save server is disabled until the URL changes, and commits the trimmed value', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    pressByTestID(tree, 'settings-signaling-row');

    const saveBtn = tree.root
      .findAllByType('AppButton')
      .find((b: any) => b.props.testID === 'settings-save-signaling');
    expect(saveBtn.props.disabled).toBe(true);

    act(() => {
      findByTestID(tree, 'settings-signaling-input')[0].props.onChangeText('  https://other.example.com  ');
    });
    act(() => {
      tree.root
        .findAllByType('AppButton')
        .find((b: any) => b.props.testID === 'settings-save-signaling')
        .props.onPress();
    });

    expect(baseProps.onSaveSignalingUrl).toHaveBeenCalledWith('https://other.example.com');
    // Committing closes the editor.
    expect(findByTestID(tree, 'settings-signaling-input')).toHaveLength(0);
  });

  test('sign out and back buttons invoke their handlers', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    act(() => {
      findByTestID(tree, 'settings-sign-out')[0].props.onPress();
    });
    act(() => {
      findByTestID(tree, 'settings-back')[0].props.onPress();
    });
    expect(baseProps.onSignOut).toHaveBeenCalled();
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  test('export logs control is only shown when onExportLogs is provided', () => {
    let withoutTree;
    act(() => {
      withoutTree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    expect(findByTestID(withoutTree, 'settings-export-logs')).toHaveLength(0);

    let withTree: any;
    const onExportLogs = jest.fn();
    act(() => {
      withTree = renderer.create(<SettingsScreen {...baseProps} onExportLogs={onExportLogs} />);
    });
    // Exactly one row: a testID that appears twice makes every other
    // assertion about it ambiguous, and the user sees the same control twice.
    // Host-only, because the composite carries the same testID as a prop.
    expect(
      findByTestID(withTree, 'settings-export-logs').filter((n: any) => typeof n.type === 'string'),
    ).toHaveLength(1);
    pressByTestID(withTree, 'settings-export-logs');
    expect(onExportLogs).toHaveBeenCalled();
  });

  test('developer-mode toggle is only shown when onToggleDeveloperMode is provided', () => {
    let withoutTree;
    act(() => {
      withoutTree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    expect(findByTestID(withoutTree, 'settings-developer-mode')).toHaveLength(0);

    const onToggleDeveloperMode = jest.fn();
    let withTree;
    act(() => {
      withTree = renderer.create(
        <SettingsScreen
          {...baseProps}
          developerModeEnabled={false}
          onToggleDeveloperMode={onToggleDeveloperMode}
        />,
      );
    });
    const toggle = findByTestID(withTree, 'settings-developer-mode').filter(
      (n: any) => typeof n.type === 'string',
    )[0];
    expect(toggle.props.accessibilityState).toEqual({ checked: false, disabled: false });
    pressByTestID(withTree, 'settings-developer-mode');
    expect(onToggleDeveloperMode).toHaveBeenCalledTimes(1);
  });

  test('developer-mode toggle reflects the enabled state', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <SettingsScreen {...baseProps} developerModeEnabled onToggleDeveloperMode={jest.fn()} />,
      );
    });
    const toggle = findByTestID(tree, 'settings-developer-mode').filter(
      (n: any) => typeof n.type === 'string',
    )[0];
    expect(toggle.props.accessibilityState).toEqual({ checked: true, disabled: false });
  });


  test('ICE transport policy selector reflects and changes the selected value', () => {
    const onChangeIceTransportPolicy = jest.fn();
    let tree: any;
    act(() => {
      tree = renderer.create(
        <SettingsScreen
          {...baseProps}
          developerModeEnabled
          onToggleDeveloperMode={jest.fn()}
          iceTransportPolicy="relay"
          onChangeIceTransportPolicy={onChangeIceTransportPolicy}
        />,
      );
    });

    expect(findByTestID(tree, 'settings-ice-policy-relay')[0].props.accessibilityState).toEqual({
      selected: true,
      checked: true,
    });
    expect(findByTestID(tree, 'settings-ice-policy-all')[0].props.accessibilityState).toEqual({
      selected: false,
      checked: false,
    });

    act(() => {
      findByTestID(tree, 'settings-ice-policy-all')[0].props.onPress();
    });
    expect(onChangeIceTransportPolicy).toHaveBeenCalledWith('all');
  });

  test('groups the settings under the headings the plan calls for', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <SettingsScreen
          {...baseProps}
          onExportLogs={jest.fn()}
          developerModeEnabled
          onToggleDeveloperMode={jest.fn()}
        />,
      );
    });

    // Grouped by what a person came to do, not by which subsystem owns the
    // value: "Signaling server" and "Developer" were implementation labels.
    [
      'Account',
      'Notifications',
      'Appearance',
      'Privacy',
      'Storage & data',
      'Advanced',
      'About',
    ].forEach(label => {
      const match = tree.root.findAll((n: any) => n.type === 'Text' && n.props.children === label);
      expect(match.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('notifications', () => {
    test('the message-notifications switch reflects and reports its state', () => {
      const onToggle = jest.fn();
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen
            {...baseProps}
            messageNotificationsEnabled={false}
            onToggleMessageNotifications={onToggle}
          />,
        );
      });

      const toggle = findByTestID(tree, 'settings-message-notifications').filter(
        (n: any) => typeof n.type === 'string',
      )[0];
      expect(toggle.props.accessibilityState.checked).toBe(false);

      pressByTestID(tree, 'settings-message-notifications');
      expect(onToggle).toHaveBeenCalledWith(true);
    });

    test('shows an empty state when nobody is muted', () => {
      let tree: any;
      act(() => {
        tree = renderer.create(<SettingsScreen {...baseProps} mutedPeers={[]} />);
      });
      expect(findByTestID(tree, 'settings-muted-empty').length).toBeGreaterThan(0);
      expect(findByTestID(tree, 'settings-muted-row')).toHaveLength(0);
    });

    test('lists muted people and unmutes the one that was tapped', () => {
      const onUnmutePeer = jest.fn();
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen
            {...baseProps}
            mutedPeers={['user-bob', 'user-carol']}
            onUnmutePeer={onUnmutePeer}
          />,
        );
      });

      const rows = findByTestID(tree, 'settings-muted-row').filter(
        (n: any) => typeof n.type === 'string',
      );
      expect(rows).toHaveLength(2);

      pressByTestID(tree, 'settings-unmute');
      expect(onUnmutePeer).toHaveBeenCalledWith('user-bob');
    });
  });

  describe('privacy', () => {
    test('shows an empty state when nobody is blocked', () => {
      let tree: any;
      act(() => {
        tree = renderer.create(<SettingsScreen {...baseProps} blockedUsers={[]} />);
      });
      expect(findByTestID(tree, 'settings-blocked-empty').length).toBeGreaterThan(0);
      expect(findByTestID(tree, 'settings-blocked-row')).toHaveLength(0);
    });

    test('lists blocked people and unblocks the one that was tapped', () => {
      const onUnblockUser = jest.fn();
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen {...baseProps} blockedUsers={['user-bob']} onUnblockUser={onUnblockUser} />,
        );
      });

      expect(
        findByTestID(tree, 'settings-blocked-row').filter((n: any) => typeof n.type === 'string'),
      ).toHaveLength(1);

      act(() => {
        findByTestID(tree, 'settings-unblock')
          .filter((n: any) => typeof n.props?.onPress === 'function')[0]
          .props.onPress();
      });
      expect(onUnblockUser).toHaveBeenCalledWith('user-bob');
    });

    test('a blocked person routes to their profile, where the rest of the controls are', () => {
      const onOpenProfile = jest.fn();
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen
            {...baseProps}
            blockedUsers={['user-bob']}
            onOpenProfile={onOpenProfile}
          />,
        );
      });

      pressByTestID(tree, 'settings-blocked-row');
      expect(onOpenProfile).toHaveBeenCalledWith('user-bob');
    });
  });

  describe('transient confirmations', () => {
    /** The rendered toast message, or null when no toast is showing. */
    function toastMessage(tree: any) {
      const host = findByTestID(tree, 'settings-toast').filter(
        (n: any) => typeof n.type !== 'string',
      )[0];
      return host?.props?.message ?? null;
    }

    test('says nothing until something has happened', () => {
      let tree: any;
      act(() => {
        tree = renderer.create(<SettingsScreen {...baseProps} />);
      });
      expect(toastMessage(tree)).toBeNull();
    });

    test('confirms clearing cached media only once the clear has finished', () => {
      const onClearCachedMedia = jest.fn();
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen {...baseProps} onClearCachedMedia={onClearCachedMedia} />,
        );
      });

      pressByTestID(tree, 'settings-clear-media');
      expect(onClearCachedMedia).toHaveBeenCalled();
      // The delete is asynchronous: confirming on the tap would promise an
      // outcome nobody has observed yet.
      expect(toastMessage(tree)).toBeNull();

      act(() => {
        tree.update(
          <SettingsScreen
            {...baseProps}
            onClearCachedMedia={onClearCachedMedia}
            isClearingMedia
          />,
        );
      });
      expect(toastMessage(tree)).toBeNull();

      act(() => {
        tree.update(
          <SettingsScreen {...baseProps} onClearCachedMedia={onClearCachedMedia} />,
        );
      });
      expect(toastMessage(tree)).toBe('Cached media cleared');
    });

    test('says nothing when the screen simply opens without a clear in flight', () => {
      // The transition guard, not just the current value: a screen that mounts
      // with `isClearingMedia` false must not announce a clear that never ran.
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen {...baseProps} onClearCachedMedia={jest.fn()} />,
        );
      });
      act(() => {
        tree.update(<SettingsScreen {...baseProps} onClearCachedMedia={jest.fn()} />);
      });
      expect(toastMessage(tree)).toBeNull();
    });

    test('confirms unmuting and unblocking by name', () => {
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen
            {...baseProps}
            mutedPeers={['user-bob']}
            onUnmutePeer={jest.fn()}
            blockedUsers={['user-carol']}
            onUnblockUser={jest.fn()}
          />,
        );
      });

      pressByTestID(tree, 'settings-unmute');
      expect(toastMessage(tree)).toBe('user-bob unmuted');

      pressByTestID(tree, 'settings-unblock');
      expect(toastMessage(tree)).toBe('user-carol unblocked');
    });

    test('a persistent condition stays on the banner, not the toast', () => {
      // The three-level rule: a condition that is still true occupies layout
      // until it stops being true; only completed events fade away.
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen
            {...baseProps}
            status={{ message: 'Server unreachable', severity: 'error' }}
          />,
        );
      });

      expect(toastMessage(tree)).toBeNull();
      expect(findByTestID(tree, 'status-banner').length).toBeGreaterThan(0);
    });

    test('clears itself when the toast dismisses', () => {
      let tree: any;
      act(() => {
        tree = renderer.create(
          <SettingsScreen {...baseProps} mutedPeers={['user-bob']} onUnmutePeer={jest.fn()} />,
        );
      });

      pressByTestID(tree, 'settings-unmute');
      const toast = findByTestID(tree, 'settings-toast').filter(
        (n: any) => typeof n.type !== 'string',
      )[0];
      act(() => {
        toast.props.onDismiss();
      });
      expect(toastMessage(tree)).toBeNull();
    });
  });

  describe('appearance', () => {
    function renderWithTheme(mode: any, setMode: any) {
      let tree;
      act(() => {
        tree = renderer.create(
          <ThemeContext.Provider
            value={buildTheme(mode, mode === 'light' ? 'light' : 'dark', setMode)}>
            <SettingsScreen {...baseProps} />
          </ThemeContext.Provider>,
        );
      });
      return tree;
    }

    test('marks the active appearance mode as selected', () => {
      const tree = renderWithTheme('light', jest.fn());
      expect(findByTestID(tree, 'settings-theme-light')[0].props.accessibilityState).toEqual({
        selected: true,
        checked: true,
      });
      expect(findByTestID(tree, 'settings-theme-system')[0].props.accessibilityState).toEqual({
        selected: false,
        checked: false,
      });
    });

    test('choosing a mode calls setMode with it', () => {
      const setMode = jest.fn();
      const tree = renderWithTheme('system', setMode);
      act(() => {
        findByTestID(tree, 'settings-theme-dark')[0].props.onPress();
      });
      expect(setMode).toHaveBeenCalledWith('dark');
    });
  });
});
