import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AppTabBar from '../../src/components/AppTabBar';

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

function render(props?: any): any {
  let tree: any;
  act(() => {
    tree = renderer.create(<AppTabBar activeTab="chats" onChangeTab={jest.fn()} {...props} />);
  });
  return tree;
}

describe('AppTabBar', () => {
  test('renders all three tabs', () => {
    const tree = render();
    expect(findByTestId(tree, 'app-tab-chats')).not.toBeNull();
    expect(findByTestId(tree, 'app-tab-calls')).not.toBeNull();
    expect(findByTestId(tree, 'app-tab-settings')).not.toBeNull();
  });

  test('tapping a tab calls onChangeTab with the tab key', () => {
    const onChangeTab = jest.fn();
    const tree = render({ onChangeTab });
    act(() => {
      findByTestId(tree, 'app-tab-calls').props.onPress();
    });
    expect(onChangeTab).toHaveBeenCalledWith('calls');
  });

  test('shows an unread badge on the Chats tab when unreadCount > 0', () => {
    const withoutBadge = render({ unreadCount: 0 });
    expect(findByTestId(withoutBadge, 'app-tab-chats-badge')).toBeNull();

    const withBadge = render({ unreadCount: 5 });
    const badge = findByTestId(withBadge, 'app-tab-chats-badge');
    expect(badge).not.toBeNull();
  });

  test('caps the badge label at 99+', () => {
    const tree = render({ unreadCount: 150 });
    const badgeText = tree.root.findAll((n: any) => n.props?.children === '99+');
    expect(badgeText.length).toBeGreaterThan(0);
  });

  test('marks the active tab via accessibilityState', () => {
    const tree = render({ activeTab: 'settings' });
    expect(findByTestId(tree, 'app-tab-settings').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(findByTestId(tree, 'app-tab-chats').props.accessibilityState).toEqual({
      selected: false,
    });
  });

  test('pads the bottom of the bar by bottomInset, so it clears gesture navigation', () => {
    const flat = (style: any) => (Array.isArray(style) ? Object.assign({}, ...style) : style);

    const withoutInset = flat(findByTestId(render({ bottomInset: 0 }), 'app-tab-bar').props.style);
    const withInset = flat(findByTestId(render({ bottomInset: 24 }), 'app-tab-bar').props.style);

    expect(withInset.paddingBottom).toBeGreaterThan(withoutInset.paddingBottom);
    expect(withInset.paddingBottom).toBeGreaterThanOrEqual(24);
  });
});
