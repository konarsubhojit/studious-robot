import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AppTabBar from '../../src/components/AppTabBar';
import CallControls from '../../src/components/CallControls';
import CallStage from '../../src/components/CallStage';
import { ListItem } from '../../src/components/primitives';
import { fontScaleCaps } from '../../src/theme';

jest.mock(
  '../../src/components/AudioOutputMenu',
  () => (props: any) => require('react').createElement('AudioOutputMenu', props),
);

jest.mock(
  '../../src/SafeRTCView',
  () => (props: any) => require('react').createElement('SafeRTCView', props),
);
jest.mock(
  '../../src/components/DraggablePip',
  () => (props: any) => require('react').createElement('DraggablePip', props),
);

function render(element: React.ReactElement) {
  let tree: any;
  act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

function findByTestId(tree: any, testID: string) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

/**
 * Host `Text` nodes only. A composite that takes `numberOfLines` or
 * `maxFontSizeMultiplier` through to a child would otherwise match first and
 * carry none of the rendered values.
 */
function textNodeWith(tree: any, content: string) {
  return (
    tree.root.findAll((n: any) => n.type === 'Text' && n.props?.children === content)[0] ?? null
  );
}

/**
 * Assistive technologies get their information from props, never from pixels,
 * so anything conveyed purely by colour, position or a floating badge has to
 * be restated in the accessibility tree.  These tests pin the places where we
 * previously conveyed state visually only.
 */
describe('accessibility contracts', () => {
  describe('unread badges', () => {
    test('the chats tab restates its unread count in its accessible name', () => {
      const tree = render(
        <AppTabBar activeTab="calls" onChangeTab={() => {}} unreadCount={4} />,
      );

      // The badge lives inside the Pressable, so its text is swallowed by the
      // Pressable's own accessible name and never announced on its own.
      expect(findByTestId(tree, 'app-tab-chats').props.accessibilityLabel).toBe('Chats, 4 unread');
    });

    test('the chats tab drops the unread suffix when the count is zero', () => {
      const tree = render(<AppTabBar activeTab="calls" onChangeTab={() => {}} />);

      expect(findByTestId(tree, 'app-tab-chats').props.accessibilityLabel).toBe('Chats');
    });
  });

  describe('call control toggles', () => {
    function controls(overrides: Record<string, unknown> = {}) {
      return render(
        <CallControls
          isMuted={false}
          isVideoEnabled
          hasLocalStream
          audioDevices={{ available: [], selected: null }}
          isSpeakerEnabled
          onMuteToggle={() => {}}
          onVideoToggle={() => {}}
          onChooseAudioOutput={() => {}}
          onCameraSwitch={() => {}}
          onLeave={() => {}}
          {...(overrides as any)}
        />,
      );
    }

    test('reports the engaged state of the mute toggle', () => {
      expect(findByTestId(controls({ isMuted: true }), 'control-mute').props.selected).toBe(true);
      expect(findByTestId(controls(), 'control-mute').props.selected).toBe(false);
    });

    test('reports a stopped camera as the engaged state of the video toggle', () => {
      const stopped = findByTestId(controls({ isVideoEnabled: false }), 'control-video');
      expect(stopped.props.selected).toBe(true);
      expect(findByTestId(controls(), 'control-video').props.selected).toBe(false);
    });

    test('reports the engaged state of the screen-share rows in the More sheet', () => {
      const tree = controls({
        onScreenShareToggle: () => {},
        onScreenAudioToggle: () => {},
        isScreenSharing: true,
        isScreenAudioEnabled: true,
      });

      // Screen sharing lives behind "More"; the affordance itself must report
      // that something inside it is engaged, or an active share is invisible.
      const more = findByTestId(tree, 'control-more');
      expect(more.props.selected).toBe(true);

      act(() => {
        more.props.onPress();
      });

      expect(findByTestId(tree, 'control-screen-share').props.accessibilityState.checked).toBe(
        true,
      );
      expect(findByTestId(tree, 'control-screen-audio').props.accessibilityState.checked).toBe(
        true,
      );
    });
  });

  describe('call stage announcements', () => {
    test('announces the presenter banner instead of leaving it silent', () => {
      const tree = render(
        <CallStage
          onLayout={() => {}}
          pipGesture={undefined as never}
          animatedPipStyle={undefined as never}
          mainStreamUrl="rtc://main"
          hasMainStream
          pipStreamUrl={null}
          hasPipStream={false}
          mirrorPip={false}
          mirrorMain={false}
          isMuted={false}
          isVideoEnabled
          isCompact={false}
          isScreenSharing
          participantLabel="Ada"
        />,
      );

      const banner = findByTestId(tree, 'presenter-banner');
      expect(banner.props.accessibilityLiveRegion).toBe('polite');
      expect(banner.props.accessibilityRole).toBe('alert');
    });
  });

  /**
   * The 200% dynamic-type contract.
   *
   * A cap is a last resort, applied only where the container is fixed in dp or
   * is a circle/pill/fixed-width column and would therefore *clip* rather than
   * reflow. Everything else has to grow. These tests pin both halves of that,
   * because the failure modes are opposite: a missing cap truncates a control,
   * and a needless cap makes running text unreadable for the people who turned
   * the font size up in the first place.
   */
  describe('dynamic type', () => {
    function deck(overrides: Record<string, unknown> = {}) {
      return render(
        <CallControls
          isMuted={false}
          isVideoEnabled
          hasLocalStream
          audioDevices={{ available: [], selected: null }}
          isSpeakerEnabled
          onMuteToggle={() => {}}
          onVideoToggle={() => {}}
          onChooseAudioOutput={() => {}}
          onCameraSwitch={() => {}}
          onLeave={() => {}}
          {...(overrides as any)}
        />,
      );
    }

    test('caps every tab-bar label: the bar is one row of three fixed columns', () => {
      const tree = render(<AppTabBar activeTab="chats" onChangeTab={() => {}} />);

      ['Chats', 'Calls', 'Settings'].forEach(label => {
        expect(textNodeWith(tree, label).props.maxFontSizeMultiplier).toBe(fontScaleCaps.control);
      });
    });

    test('caps the control-deck caption, so Leave cannot be pushed off the deck', () => {
      const tree = deck({ isScreenSharing: true, onScreenShareToggle: () => {} });

      const caption = tree.root.findAll(
        (n: any) => n.type === 'Text' && n.props?.testID === 'screen-share-indicator',
      )[0];
      expect(caption.props.maxFontSizeMultiplier).toBe(fontScaleCaps.control);
    });

    test('wraps the ambient canvas peer name rather than capping or clipping it', () => {
      const tree = render(
        <CallStage
          onLayout={() => {}}
          pipGesture={undefined as never}
          animatedPipStyle={undefined as never}
          mainStreamUrl={null}
          hasMainStream={false}
          pipStreamUrl={null}
          hasPipStream={false}
          mirrorPip={false}
          isCompact={false}
          isAudioOnly
          participantLabel="alexandra-fitzwilliam"
        />,
      );

      // The canvas is `flex: 1` and centred: it has room, so the name reflows.
      const name = textNodeWith(tree, 'alexandra-fitzwilliam');
      expect(name.props.numberOfLines).toBe(2);
      expect(name.props.maxFontSizeMultiplier).toBeUndefined();
    });

    test('a list row wraps its title and caps only the boxed value column', () => {
      const tree = render(<ListItem title="Signaling server" value="wss://example.test" />);

      // `minHeight` row + `flex: 1` text column: the title has somewhere to go.
      const title = textNodeWith(tree, 'Signaling server');
      expect(title.props.numberOfLines).toBe(2);
      expect(title.props.maxFontSizeMultiplier).toBeUndefined();
      // The value is boxed into `maxWidth: '40%'` and cannot be given more.
      expect(textNodeWith(tree, 'wss://example.test').props.maxFontSizeMultiplier).toBe(
        fontScaleCaps.meta,
      );
    });

    test('leaves the row subtitle uncapped: it is running text', () => {
      const tree = render(
        <ListItem title="Include screen audio" subtitle="Shares what your device is playing" />,
      );

      expect(
        textNodeWith(tree, 'Shares what your device is playing').props.maxFontSizeMultiplier,
      ).toBeUndefined();
    });
  });
});
