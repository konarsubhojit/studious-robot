import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { Sheet } from '../../src/components/primitives';

/** Renders the sheet and lets the asynchronous accessibility read resolve. */
async function renderSheet() {
  let tree: any;
  await act(async () => {
    tree = renderer.create(
      <Sheet visible onClose={jest.fn()} title="Attach" testID="sheet">
        <Text>body</Text>
      </Sheet>,
    );
  });
  return tree;
}

/** The one `Modal` the sheet renders. */
function modalProps(tree: any) {
  return tree.root.findAll((n: any) => n.props?.animationType !== undefined)[0].props;
}

describe('Sheet', () => {
  afterEach(() => jest.restoreAllMocks());

  test('renders nothing until it is visible', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <Sheet visible={false} onClose={jest.fn()} title="Attach">
          <Text>body</Text>
        </Sheet>,
      );
    });
    expect(tree.toJSON()).toBeNull();
  });

  test('fades in by default', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const tree = await renderSheet();
    expect(modalProps(tree).animationType).toBe('fade');
  });

  test('appears without a transition under reduced motion', async () => {
    // The sheet still opens and still closes — only the fade is dropped, so the
    // user never loses the state change itself.
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const tree = await renderSheet();

    expect(modalProps(tree).animationType).toBe('none');
    expect(tree.root.findAll((n: any) => n.props?.testID === 'sheet').length).toBeGreaterThan(0);
  });
});
