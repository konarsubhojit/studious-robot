import React from 'react';
import { Linking } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import InAppMessageBanner from '../../src/components/InAppMessageBanner';
import { ProfileDataProvider } from '../../src/profile/ProfileContext';
import { installRenderCleanup } from '../../testUtils/renderCleanup';
import {
  dismissInAppMessageNotification,
  enqueueInAppMessageNotification,
  resetInAppMessageNotifications,
} from '../../src/inAppMessageNotifications';

installRenderCleanup();

async function renderWithProfiles(profileUserId = 'alice') {
  const transport = {
    userId: 'self', signalingUrl: 'https://signal.example',
    authedFetch: jest.fn(async () => null),
    searchUsers: jest.fn(async () => [{ userId: profileUserId, displayName: '  Alice Name  ', avatarKey: null }]),
  };
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<ProfileDataProvider transport={transport}><InAppMessageBanner /></ProfileDataProvider>);
  });
  return tree;
}

function render() {
  let tree: any;
  act(() => {
    tree = renderer.create(<InAppMessageBanner />);
  });
  return tree;
}

function findByTestId(tree: any, testID: string) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

function textsOf(tree: any): string[] {
  return tree.root
    .findAll((node: any) => typeof node.type === 'string')
    .flatMap((node: any) =>
      (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).filter(
        (child: unknown) => typeof child === 'string',
      ),
    );
}

function enqueue(overrides: any = {}) {
  act(() => {
    enqueueInAppMessageNotification({
      messageId: 'message-1',
      conversationId: 'alice:bob',
      senderId: 'alice',
      title: 'Alice',
      body: '📷 Photo',
      deepLink: 'wetalk://chat/alice:bob',
      ...overrides,
    });
  });
}

describe('InAppMessageBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    resetInAppMessageNotifications();
  });

  afterEach(() => {
    resetInAppMessageNotifications();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('renders the current queued message preview', () => {
    const tree = render();

    enqueue();

    expect(textsOf(tree)).toEqual(expect.arrayContaining(['Alice', '📷 Photo']));
    expect(findByTestId(tree, 'in-app-message-banner').props.accessibilityLabel).toBe(
      'Alice. 📷 Photo',
    );
  });

  test('resolves socket raw-ID titles without changing body or raw deep link', async () => {
    const tree = await renderWithProfiles();
    enqueue({ title: 'alice' });
    expect(textsOf(tree)).toEqual(expect.arrayContaining(['Alice Name', '📷 Photo']));
    expect(findByTestId(tree, 'in-app-message-banner').props.accessibilityLabel).toBe('Alice Name. 📷 Photo');
    await act(async () => { findByTestId(tree, 'in-app-message-banner').props.onPress(); });
    expect(Linking.openURL).toHaveBeenCalledWith('wetalk://chat/alice:bob');
  });

  test.each(['New message', 'Parent Resolved Name'])('preserves privacy or supplied title %p', async title => {
    const tree = await renderWithProfiles();
    enqueue({ title, body: 'Hidden message' });
    expect(textsOf(tree)).toContain(title);
    expect(textsOf(tree)).not.toContain('Alice Name');
    expect(findByTestId(tree, 'in-app-message-banner').props.accessibilityLabel).toBe(`${title}. Hidden message`);
  });

  test.each([
    ['Open WeTalk to view it.', 'New WeTalk message'],
    ['Visible message body', 'Alice Name'],
  ])('handles a username colliding with the generic privacy title for body %p', async (body, expectedTitle) => {
    const senderId = 'New WeTalk message';
    const deepLink = 'wetalk://chat/self:New%20WeTalk%20message';
    const tree = await renderWithProfiles(senderId);
    enqueue({ senderId, title: senderId, body, deepLink });
    expect(textsOf(tree)).toEqual(expect.arrayContaining([expectedTitle, body]));
    expect(findByTestId(tree, 'in-app-message-banner').props.accessibilityLabel).toBe(`${expectedTitle}. ${body}`);
    if (expectedTitle === senderId) expect(textsOf(tree)).not.toContain('Alice Name');
    await act(async () => { findByTestId(tree, 'in-app-message-banner').props.onPress(); });
    expect(Linking.openURL).toHaveBeenCalledWith(deepLink);
  });

  test('queues later messages instead of stacking them', () => {
    const tree = render();

    enqueue();
    enqueue({ messageId: 'message-2', title: 'Carol', body: 'second' });

    expect(textsOf(tree)).toEqual(expect.arrayContaining(['Alice', '📷 Photo']));
    expect(textsOf(tree)).not.toContain('Carol');

    act(() => {
      dismissInAppMessageNotification('message-1');
    });

    expect(textsOf(tree)).toEqual(expect.arrayContaining(['Carol', 'second']));
  });

  test('opens the deep link and dismisses when tapped', async () => {
    const tree = render();
    enqueue();

    await act(async () => {
      findByTestId(tree, 'in-app-message-banner').props.onPress();
      await Promise.resolve();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('wetalk://chat/alice:bob');
    expect(findByTestId(tree, 'in-app-message-banner')).toBeNull();
  });

  test('dismisses from the visible button and accessibility action', () => {
    const tree = render();
    enqueue();

    act(() => {
      findByTestId(tree, 'in-app-message-banner-dismiss').props.onPress();
    });
    expect(findByTestId(tree, 'in-app-message-banner')).toBeNull();

    enqueue({ messageId: 'message-2' });
    act(() => {
      findByTestId(tree, 'in-app-message-banner').props.onAccessibilityAction({
        nativeEvent: { actionName: 'dismiss' },
      });
    });
    expect(findByTestId(tree, 'in-app-message-banner')).toBeNull();
  });

  test('auto-dismisses after a short delay', () => {
    const tree = render();
    enqueue();

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(findByTestId(tree, 'in-app-message-banner')).toBeNull();
  });
});
