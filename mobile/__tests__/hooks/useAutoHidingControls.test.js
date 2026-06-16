import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import useAutoHidingControls, {
  DEFAULT_CONTROLS_HIDE_DELAY_MS,
} from '../../src/hooks/useAutoHidingControls';

let api;

function Harness({ enabled = true, hideDelayMs }) {
  api = useAutoHidingControls({ enabled, hideDelayMs });
  return <Text>{api.visible ? 'visible' : 'hidden'}</Text>;
}

function render(props) {
  let tree;
  act(() => {
    tree = renderer.create(<Harness {...props} />);
  });
  return tree;
}

describe('useAutoHidingControls', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    api = null;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('starts visible and auto-hides after the inactivity delay', () => {
    render({ hideDelayMs: 1000 });
    expect(api.visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(api.visible).toBe(false);
  });

  it('reveal() shows the deck again and restarts the timer', () => {
    render({ hideDelayMs: 1000 });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(api.visible).toBe(false);

    act(() => {
      api.reveal();
    });
    expect(api.visible).toBe(true);

    // Half the delay then activity → still visible (timer was reset).
    act(() => {
      jest.advanceTimersByTime(600);
      api.reveal();
      jest.advanceTimersByTime(600);
    });
    expect(api.visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(api.visible).toBe(false);
  });

  it('hold(true) pins the deck visible and hold(false) resumes auto-hide', () => {
    render({ hideDelayMs: 1000 });
    act(() => {
      api.hold(true);
      jest.advanceTimersByTime(5000);
    });
    expect(api.visible).toBe(true);

    act(() => {
      api.hold(false);
      jest.advanceTimersByTime(1000);
    });
    expect(api.visible).toBe(false);
  });

  it('stays visible and runs no timer when disabled', () => {
    render({ enabled: false, hideDelayMs: 1000 });
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(api.visible).toBe(true);
  });

  it('exposes a sensible default hide delay', () => {
    expect(DEFAULT_CONTROLS_HIDE_DELAY_MS).toBeGreaterThan(0);
  });
});
