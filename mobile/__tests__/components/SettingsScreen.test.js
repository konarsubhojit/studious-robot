import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SettingsScreen from '../../src/components/SettingsScreen';
import ThemeContext, { buildTheme } from '../../src/ThemeContext';

jest.mock(
  '../../src/components/AppButton',
  () => props => require('react').createElement('AppButton', props),
);

const baseProps = {
  userId: 'alice',
  onSaveUserId: jest.fn(),
  signalingUrl: 'https://signal.example.com',
  onSaveSignalingUrl: jest.fn(),
  onSignOut: jest.fn(),
  onClose: jest.fn(),
  status: { message: '', severity: 'info' },
};

function findByTestID(tree, id) {
  return tree.root.findAll(n => n.props.testID === id);
}

describe('SettingsScreen', () => {
  afterEach(() => jest.clearAllMocks());

  test('renders the username and signaling inputs seeded from props', () => {
    let tree;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    const usernameInput = findByTestID(tree, 'settings-username-input')[0];
    const signalingInput = findByTestID(tree, 'settings-signaling-input')[0];
    expect(usernameInput.props.value).toBe('alice');
    expect(signalingInput.props.value).toBe('https://signal.example.com');
  });

  test('Save username is disabled until the value changes', () => {
    let tree;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    const saveBtn = tree.root
      .findAllByType('AppButton')
      .find(b => b.props.testID === 'settings-save-username');
    expect(saveBtn.props.disabled).toBe(true);

    act(() => {
      findByTestID(tree, 'settings-username-input')[0].props.onChangeText('bob');
    });
    const saveBtnAfter = tree.root
      .findAllByType('AppButton')
      .find(b => b.props.testID === 'settings-save-username');
    expect(saveBtnAfter.props.disabled).toBe(false);
  });

  test('saving a new username calls onSaveUserId with the trimmed value', () => {
    let tree;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    act(() => {
      findByTestID(tree, 'settings-username-input')[0].props.onChangeText('  bob  ');
    });
    act(() => {
      tree.root
        .findAllByType('AppButton')
        .find(b => b.props.testID === 'settings-save-username')
        .props.onPress();
    });
    expect(baseProps.onSaveUserId).toHaveBeenCalledWith('bob');
  });

  test('Save server is disabled until the URL changes', () => {
    let tree;
    act(() => {
      tree = renderer.create(<SettingsScreen {...baseProps} />);
    });
    const saveBtn = tree.root
      .findAllByType('AppButton')
      .find(b => b.props.testID === 'settings-save-signaling');
    expect(saveBtn.props.disabled).toBe(true);
  });

  test('sign out and back buttons invoke their handlers', () => {
    let tree;
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

    let withTree;
    const onExportLogs = jest.fn();
    act(() => {
      withTree = renderer.create(<SettingsScreen {...baseProps} onExportLogs={onExportLogs} />);
    });
    act(() => {
      withTree.root
        .findAllByType('AppButton')
        .find(b => b.props.testID === 'settings-export-logs')
        .props.onPress();
    });
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
    const toggle = findByTestID(withTree, 'settings-developer-mode')[0];
    expect(toggle.props.accessibilityState).toEqual({ checked: false });
    act(() => {
      toggle.props.onPress();
    });
    expect(onToggleDeveloperMode).toHaveBeenCalledTimes(1);
  });

  test('developer-mode toggle reflects the enabled state', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <SettingsScreen {...baseProps} developerModeEnabled onToggleDeveloperMode={jest.fn()} />,
      );
    });
    const toggle = findByTestID(tree, 'settings-developer-mode')[0];
    expect(toggle.props.accessibilityState).toEqual({ checked: true });
  });

  test('renders section labels with the expected text for each visible section', () => {
    let tree;
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

    ['Username', 'Signaling server', 'Appearance', 'Developer', 'Account'].forEach(label => {
      const match = tree.root.findAll(n => n.type === 'Text' && n.props.children === label);
      expect(match.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('appearance', () => {
    function renderWithTheme(mode, setMode) {
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
