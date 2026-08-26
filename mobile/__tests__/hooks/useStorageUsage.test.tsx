import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useStorageUsage from '../../src/hooks/useStorageUsage';

jest.mock('../../src/appLogger', () => ({ logWarn: jest.fn() }));
jest.mock('../../src/storageUsage', () => ({
  EMPTY_STORAGE_USAGE: {
    totalBytes: 0,
    mediaBytes: 0,
    logBytes: 0,
    dataBytes: 0,
    mediaFileCount: 0,
    measured: false,
  },
  measureStorageUsage: jest.fn(),
  clearCachedMedia: jest.fn(),
  describeClearMediaResult: jest.fn(() => 'Freed 1.0 KB.'),
}));

const { measureStorageUsage, clearCachedMedia } = require('../../src/storageUsage');

const MEASURED = {
  totalBytes: 1024,
  mediaBytes: 1024,
  logBytes: 0,
  dataBytes: 0,
  mediaFileCount: 1,
  measured: true,
};

let latest: any = null;

function TestHook({ onStatus }: any) {
  latest = useStorageUsage({ onStatus });
  return null;
}

async function render(onStatus?: any) {
  let tree: any;
  await act(async () => {
    tree = renderer.create(<TestHook onStatus={onStatus} />);
  });
  return tree;
}

describe('useStorageUsage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    latest = null;
    (measureStorageUsage as jest.Mock).mockResolvedValue(MEASURED);
    (clearCachedMedia as jest.Mock).mockResolvedValue({
      removedFiles: 1,
      freedBytes: 1024,
      failedFiles: 0,
      skippedFiles: 0,
    });
  });

  test('does not crawl the filesystem until asked', async () => {
    await render();

    // Nothing outside the Settings screen reads this number, and the crawl is
    // not free.
    expect(measureStorageUsage).not.toHaveBeenCalled();
    expect(latest.storageUsage.measured).toBe(false);
  });

  test('refreshing measures and publishes the result', async () => {
    await render();

    await act(async () => {
      await latest.refreshStorageUsage();
    });

    expect(latest.storageUsage).toEqual(MEASURED);
    expect(latest.isMeasuringStorage).toBe(false);
  });

  test('a failed measurement leaves the previous number rather than zeroing it', async () => {
    await render();
    await act(async () => {
      await latest.refreshStorageUsage();
    });

    (measureStorageUsage as jest.Mock).mockRejectedValueOnce(new Error('EACCES'));
    await act(async () => {
      await latest.refreshStorageUsage();
    });

    expect(latest.storageUsage).toEqual(MEASURED);
    expect(latest.isMeasuringStorage).toBe(false);
  });

  test('clearing reports the outcome and re-measures', async () => {
    const onStatus = jest.fn();
    await render(onStatus);

    await act(async () => {
      await latest.clearCachedMedia();
    });

    expect(clearCachedMedia).toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith('Freed 1.0 KB.', 'success');
    // The number on screen must reflect the deletion that just happened.
    expect(measureStorageUsage).toHaveBeenCalled();
    expect(latest.isClearingMedia).toBe(false);
  });

  test('a partial failure is reported as an error, not as success', async () => {
    const onStatus = jest.fn();
    (clearCachedMedia as jest.Mock).mockResolvedValue({
      removedFiles: 1,
      freedBytes: 10,
      failedFiles: 2,
      skippedFiles: 0,
    });
    await render(onStatus);

    await act(async () => {
      await latest.clearCachedMedia();
    });

    expect(onStatus).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('a thrown clear still reports and still re-measures', async () => {
    const onStatus = jest.fn();
    (clearCachedMedia as jest.Mock).mockRejectedValue(new Error('EBUSY'));
    await render(onStatus);

    await act(async () => {
      await latest.clearCachedMedia();
    });

    expect(onStatus).toHaveBeenCalledWith('Cached media could not be removed.', 'error');
    expect(measureStorageUsage).toHaveBeenCalled();
    expect(latest.isClearingMedia).toBe(false);
  });

  test('a measurement resolving after unmount does not set state', async () => {
    let resolveMeasure: any;
    (measureStorageUsage as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        resolveMeasure = resolve;
      }),
    );
    const tree = await render();

    let pending: any;
    act(() => {
      pending = latest.refreshStorageUsage();
    });
    await act(async () => {
      tree.unmount();
    });

    // Leaving Settings while the crawl is in flight is ordinary; resolving into
    // an unmounted tree is a React warning and a pointless render.
    await act(async () => {
      resolveMeasure(MEASURED);
      await pending;
    });
    expect(latest.storageUsage.measured).toBe(false);
  });
});
