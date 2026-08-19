jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  setForceSpeakerphoneOn: jest.fn(),
  setSpeakerphoneOn: jest.fn(),
  setKeepScreenOn: jest.fn(),
  chooseAudioRoute: jest.fn(),
}));

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AudioOutputMenu from '../../src/components/AudioOutputMenu';
import { AUDIO_ROUTES } from '../../src/audioRouting';

describe('AudioOutputMenu', () => {
  test('always offers speaker and earpiece, and merges reported devices', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <AudioOutputMenu
          available={[AUDIO_ROUTES.BLUETOOTH]}
          selected={AUDIO_ROUTES.BLUETOOTH}
          isSpeakerEnabled={false}
          onSelect={() => {}}
        />,
      );
    });

    // Open the dropdown.
    act(() => {
      tree.root.findByProps({ testID: 'audio-output-trigger' }).props.onPress();
    });

    expect(
      tree.root.findByProps({ testID: `audio-output-${AUDIO_ROUTES.SPEAKER_PHONE}` }),
    ).toBeTruthy();
    expect(tree.root.findByProps({ testID: `audio-output-${AUDIO_ROUTES.EARPIECE}` })).toBeTruthy();
    expect(
      tree.root.findByProps({ testID: `audio-output-${AUDIO_ROUTES.BLUETOOTH}` }),
    ).toBeTruthy();
  });

  test('invokes onSelect with the chosen route', () => {
    const onSelect = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(
        <AudioOutputMenu available={[]} selected={null} isSpeakerEnabled onSelect={onSelect} />,
      );
    });

    act(() => {
      tree.root.findByProps({ testID: 'audio-output-trigger' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: `audio-output-${AUDIO_ROUTES.EARPIECE}` }).props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith(AUDIO_ROUTES.EARPIECE);
  });
  test('unmounts the menu layer entirely once a route is chosen', () => {
    const { Modal } = require('react-native');
    let tree;
    act(() => {
      tree = renderer.create(
        <AudioOutputMenu available={[]} selected={null} isSpeakerEnabled onSelect={() => {}} />,
      );
    });
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);

    act(() => {
      tree.root.findByProps({ testID: 'audio-output-trigger' }).props.onPress();
    });
    expect(tree.root.findAllByType(Modal)).toHaveLength(1);

    act(() => {
      tree.root.findByProps({ testID: `audio-output-${AUDIO_ROUTES.EARPIECE}` }).props.onPress();
    });
    // Nothing of the menu may survive its own close: a mounted-but-invisible
    // layer is what leaves stale icons floating over the call UI.
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);
    expect(
      tree.root.findAllByProps({ testID: `audio-output-${AUDIO_ROUTES.EARPIECE}` }),
    ).toHaveLength(0);
  });

  test('closes an open menu when the control is disabled by a call-state change', () => {
    const { Modal } = require('react-native');
    let tree;
    act(() => {
      tree = renderer.create(
        <AudioOutputMenu available={[]} selected={null} isSpeakerEnabled onSelect={() => {}} />,
      );
    });
    act(() => {
      tree.root.findByProps({ testID: 'audio-output-trigger' }).props.onPress();
    });
    expect(tree.root.findAllByType(Modal)).toHaveLength(1);

    act(() => {
      tree.update(
        <AudioOutputMenu
          available={[]}
          selected={null}
          isSpeakerEnabled
          onSelect={() => {}}
          disabled
        />,
      );
    });
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  });
});
