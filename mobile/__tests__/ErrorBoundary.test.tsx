import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import ErrorBoundary from '../src/ErrorBoundary';
import { getLogsAsText } from '../src/appLogger';
import { saveCrashLog } from '../src/crashReporter';
import { captureRenderError } from '../src/crashReporting';

jest.mock('../src/appLogger', () => ({
  getLogsAsText: jest.fn(() => 'app logs'),
}));
jest.mock('../src/crashReporter', () => ({
  saveCrashLog: jest.fn(),
}));
jest.mock('../src/crashReporting', () => ({
  captureRenderError: jest.fn(),
}));

describe('ErrorBoundary', () => {
  let tree: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(saveCrashLog).mockResolvedValue({ success: true, path: '/crash.txt' });
  });

  afterEach(() => {
    if (tree) {
      act(() => tree.unmount());
      tree = undefined;
    }
    jest.restoreAllMocks();
  });

  test('renders children normally without reporting an error', async () => {
    await act(async () => {
      tree = renderer.create(
        <ErrorBoundary><Text>Healthy child</Text></ErrorBoundary>,
      );
    });

    expect(JSON.stringify(tree.toJSON())).toContain('Healthy child');
    expect(captureRenderError).not.toHaveBeenCalled();
    expect(saveCrashLog).not.toHaveBeenCalled();
  });

  test.each(['saved', 'failed', 'rejected'])(
    'reports a throwing child as non-fatal and keeps the fallback when local saving is %s',
    async outcome => {
      if (outcome === 'failed') {
        jest.mocked(saveCrashLog).mockResolvedValue({ success: false });
      } else if (outcome === 'rejected') {
        jest.mocked(saveCrashLog).mockRejectedValue(new Error('disk unavailable'));
      }
      const error = new Error('Render failed');
      function ThrowingChild(): React.ReactNode {
        throw error;
      }

      await act(async () => {
        tree = renderer.create(
          <ErrorBoundary><ThrowingChild /></ErrorBoundary>,
        );
      });

      const fallback = JSON.stringify(tree.toJSON());
      expect(fallback).toContain('Something went wrong');
      expect(fallback).toContain('Render failed');
      expect(fallback).toContain(outcome === 'saved'
        ? '/crash.txt' : 'Unable to save crash log to storage.');
      expect(captureRenderError).toHaveBeenCalledTimes(1);
      expect(captureRenderError).toHaveBeenCalledWith(
        error, expect.stringContaining('ThrowingChild'),
      );
      expect(saveCrashLog).toHaveBeenCalledTimes(1);
      expect(saveCrashLog).toHaveBeenCalledWith(error, false, getLogsAsText);
    },
  );
});
