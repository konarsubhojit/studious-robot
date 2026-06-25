import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SettingsScreen from '../../src/components/SettingsScreen';

jest.mock('../../src/components/AppButton', () => (props) =>
  require('react').createElement('AppButton', props),
);

const baseProps = {
  userId: 'alice',
  onSaveUserId: jest.fn(),
  signalingUrl: 'https://signal.example.com',
  onSaveSignalingUrl: jest.fn(),
  onSignOut: jest.fn(),
  onClose: jest.fn(),
};

function findByTestID(tree, id) {
  return tree.root.findAll((n) => n.props.testID === id);
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
      .find((b) => b.props.testID === 'settings-save-username');
    expect(saveBtn.props.disabled).toBe(true);

    act(() => {
      findByTestID(tree, 'settings-username-input')[0].props.onChangeText('bob');
    });
    const saveBtnAfter = tree.root
      .findAllByType('AppButton')
      .find((b) => b.props.testID === 'settings-save-username');
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
        .find((b) => b.props.testID === 'settings-save-username')
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
      .find((b) => b.props.testID === 'settings-save-signaling');
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
      withTree = renderer.create(
        <SettingsScreen {...baseProps} onExportLogs={onExportLogs} />,
      );
    });
    act(() => {
      withTree.root
        .findAllByType('AppButton')
        .find((b) => b.props.testID === 'settings-export-logs')
        .props.onPress();
    });
    expect(onExportLogs).toHaveBeenCalled();
  });
});
