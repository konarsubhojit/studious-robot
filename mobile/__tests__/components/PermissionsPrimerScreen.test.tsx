import React from 'react';
import renderer, { act } from 'react-test-renderer';
import PermissionsPrimerScreen from '../../src/components/PermissionsPrimerScreen';

jest.mock(
  '../../src/components/AppButton',
  () => (props: any) => require('react').createElement('AppButton', props),
);

const items = [
  {
    key: 'android.permission.RECORD_AUDIO',
    icon: 'micOn',
    title: 'Microphone',
    description: 'So the person you call can hear you.',
    required: true,
  },
  {
    key: 'android.permission.POST_NOTIFICATIONS',
    icon: 'settingsNotifications',
    title: 'Notifications',
    description: 'To tell you about incoming calls.',
    required: false,
  },
];

const baseProps: any = {
  onContinue: jest.fn(),
  onSkip: jest.fn(),
  items,
};

function findByTestID(tree: any, id: string) {
  return tree.root.findAll((n: any) => n.props.testID === id);
}

/** The composite `ListItem`s, not the host views they render into. */
function listItems(tree: any) {
  return findByTestID(tree, 'permissions-primer-item').filter(
    (n: any) => typeof n.type === 'function' && typeof n.props?.subtitle === 'string',
  );
}

function render(props: any = baseProps) {
  let tree: any;
  act(() => {
    tree = renderer.create(<PermissionsPrimerScreen {...props} />);
  });
  return tree;
}

describe('PermissionsPrimerScreen', () => {
  afterEach(() => jest.clearAllMocks());

  test('states a reason for every permission it is about to request', () => {
    const tree = render();

    const rows = listItems(tree);
    expect(rows).toHaveLength(items.length);
    rows.forEach((row: any, index: number) => {
      // The system dialog already names the permission; the reason is the only
      // thing this screen contributes.
      expect(row.props.subtitle).toBe(items[index].description);
    });
  });

  test('continuing hands over to the system dialogs', () => {
    const tree = render();

    act(() => {
      tree.root
        .findAllByType('AppButton')
        .find((b: any) => b.props.testID === 'permissions-primer-continue')
        .props.onPress();
    });

    expect(baseProps.onContinue).toHaveBeenCalled();
  });

  test('declining is reachable and does not prompt', () => {
    const tree = render();

    const skip = findByTestID(tree, 'permissions-primer-skip').find(
      (n: any) => typeof n.props?.onPress === 'function',
    );
    act(() => {
      skip.props.onPress();
    });

    expect(baseProps.onSkip).toHaveBeenCalled();
    expect(baseProps.onContinue).not.toHaveBeenCalled();
  });

  test('both choices are labelled for a screen reader', () => {
    const tree = render();

    const skip = findByTestID(tree, 'permissions-primer-skip').filter(
      (n: any) => typeof n.type === 'string',
    )[0];
    expect(skip.props.accessibilityLabel).toBe('Not now');
    expect(skip.props.accessibilityHint).toContain('asks again');

    const rows = findByTestID(tree, 'permissions-primer-item').filter(
      (n: any) => typeof n.type === 'string',
    );
    // Each row is announced as one sentence rather than as two fragments.
    expect(rows[0].props.accessibilityLabel).toContain('Microphone');
    expect(rows[0].props.accessibilityLabel).toContain('hear you');
  });

  test('rows are not announced as buttons, because they do nothing', () => {
    const tree = render();

    listItems(tree).forEach((row: any) => {
      expect(row.props.accessibilityRole).toBe('none');
      expect(row.props.onPress).toBeUndefined();
    });
  });
});
