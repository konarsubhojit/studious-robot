import { deriveCallStreams } from '../src/callStreamHelpers';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

jest.mock('../src/diagnostics', () => ({
  getStreamUrl: jest.fn((stream, _context) => {
    if (!stream || typeof stream.toURL !== 'function') return null;
    try {
      return stream.toURL();
    } catch {
      return null;
    }
  }),
}));

function makeStream(url: string) {
  return { toURL: () => url };
}

function makeVideoStream(url: string) {
  return { toURL: () => url, getVideoTracks: () => [{ id: 'v1' }] };
}

function makeAudioOnlyStream(url: string) {
  return { toURL: () => url, getVideoTracks: () => [] };
}

describe('deriveCallStreams', () => {
  test('when isLocalPrimary is true, local is main and remote is pip', () => {
    const localStream = makeStream('local://1');
    const remoteStream = makeStream('remote://1');

    const result = deriveCallStreams({
      isLocalPrimary: true,
      localStream,
      remoteStream,
      isFrontCamera: false,
      mainLabel: 'main',
      pipLabel: 'pip',
    });

    expect(result.mainStream).toBe(localStream);
    expect(result.pipStream).toBe(remoteStream);
    expect(result.mainStreamUrl).toBe('local://1');
    expect(result.pipStreamUrl).toBe('remote://1');
  });

  test('when isLocalPrimary is false, remote is main and local is pip', () => {
    const localStream = makeStream('local://1');
    const remoteStream = makeStream('remote://1');

    const result = deriveCallStreams({
      isLocalPrimary: false,
      localStream,
      remoteStream,
      isFrontCamera: false,
      mainLabel: 'main',
      pipLabel: 'pip',
    });

    expect(result.mainStream).toBe(remoteStream);
    expect(result.pipStream).toBe(localStream);
    expect(result.mainStreamUrl).toBe('remote://1');
    expect(result.pipStreamUrl).toBe('local://1');
  });

  test('mirrorMain is true only when local is primary and using the front camera', () => {
    expect(
      deriveCallStreams({
        isLocalPrimary: true,
        localStream: null,
        remoteStream: null,
        isFrontCamera: true,
        mainLabel: 'm',
        pipLabel: 'p',
      }),
    ).toMatchObject({ mirrorMain: true, mirrorPip: false });

    expect(
      deriveCallStreams({
        isLocalPrimary: true,
        localStream: null,
        remoteStream: null,
        isFrontCamera: false,
        mainLabel: 'm',
        pipLabel: 'p',
      }),
    ).toMatchObject({ mirrorMain: false, mirrorPip: false });
  });

  test('mirrorPip is true only when remote is primary (local shown as pip) and using the front camera', () => {
    expect(
      deriveCallStreams({
        isLocalPrimary: false,
        localStream: null,
        remoteStream: null,
        isFrontCamera: true,
        mainLabel: 'm',
        pipLabel: 'p',
      }),
    ).toMatchObject({ mirrorMain: false, mirrorPip: true });
  });

  test('stream URLs are null when there is no stream', () => {
    const result = deriveCallStreams({
      isLocalPrimary: true,
      localStream: null,
      remoteStream: null,
      isFrontCamera: false,
      mainLabel: 'm',
      pipLabel: 'p',
    });
    expect(result.mainStreamUrl).toBeNull();
    expect(result.pipStreamUrl).toBeNull();
  });
});

describe('deriveCallStreams mainHasVideo', () => {
  const base = {
    isLocalPrimary: false,
    isFrontCamera: false,
    mainLabel: 'main',
    pipLabel: 'pip',
  };

  test('is true when the main stream carries a video track', () => {
    const result = deriveCallStreams({
      ...base,
      localStream: null,
      remoteStream: makeVideoStream('remote://1'),
    });

    expect(result.mainHasVideo).toBe(true);
  });

  test('is false for an audio-only stream, even though it has a URL', () => {
    const result = deriveCallStreams({
      ...base,
      localStream: null,
      remoteStream: makeAudioOnlyStream('remote://1'),
    });

    expect(result.mainStreamUrl).toBe('remote://1');
    expect(result.mainHasVideo).toBe(false);
  });

  test('is false when there is no main stream at all', () => {
    const result = deriveCallStreams({ ...base, localStream: null, remoteStream: null });

    expect(result.mainHasVideo).toBe(false);
  });

  test('is false for a stream object that does not implement getVideoTracks', () => {
    const result = deriveCallStreams({
      ...base,
      localStream: null,
      remoteStream: makeStream('remote://1'),
    });

    expect(result.mainHasVideo).toBe(false);
  });

  test('reports the local stream when the local side is primary', () => {
    const result = deriveCallStreams({
      ...base,
      isLocalPrimary: true,
      localStream: makeVideoStream('local://1'),
      remoteStream: makeAudioOnlyStream('remote://1'),
    });

    expect(result.mainHasVideo).toBe(true);
  });

  test('survives a stream whose getVideoTracks throws', () => {
    const result = deriveCallStreams({
      ...base,
      localStream: null,
      remoteStream: {
        toURL: () => 'remote://1',
        getVideoTracks: () => {
          throw new Error('stream released');
        },
      },
    });

    expect(result.mainHasVideo).toBe(false);
  });
});

/**
 * Camera state, which is the half of "is there a picture" that counting tracks
 * cannot answer.
 *
 * Turning a camera off sets `track.enabled = false`; it does not remove the
 * track, and a disabled sender keeps transmitting. So a receiver that only
 * counted tracks reported `mainHasVideo: true` for a black rectangle, and the
 * ambient canvas — built, tokenised and covered — was unreachable for every
 * call this app can place. The flag is relayed over `call.media-state` and
 * arrives here as `localVideoEnabled` / `remoteVideoEnabled`.
 */
describe('deriveCallStreams camera state', () => {
  const base = {
    isFrontCamera: false,
    mainLabel: 'main',
    pipLabel: 'pip',
  };

  test('a remote camera switched off has no picture, even though its track survives', () => {
    const result = deriveCallStreams({
      ...base,
      isLocalPrimary: false,
      localStream: makeVideoStream('local://1'),
      remoteStream: makeVideoStream('remote://1'),
      localVideoEnabled: true,
      remoteVideoEnabled: false,
    });

    expect(result.mainHasVideo).toBe(false);
    // The self-view still has one, so the tile stays.
    expect(result.pipHasVideo).toBe(true);
  });

  test('a local camera switched off empties the self-view tile, not the stage', () => {
    const result = deriveCallStreams({
      ...base,
      isLocalPrimary: false,
      localStream: makeVideoStream('local://1'),
      remoteStream: makeVideoStream('remote://1'),
      localVideoEnabled: false,
      remoteVideoEnabled: true,
    });

    expect(result.mainHasVideo).toBe(true);
    expect(result.pipHasVideo).toBe(false);
  });

  test('the flags follow the tiles when the streams are swapped', () => {
    const result = deriveCallStreams({
      ...base,
      isLocalPrimary: true,
      localStream: makeVideoStream('local://1'),
      remoteStream: makeVideoStream('remote://1'),
      localVideoEnabled: false,
      remoteVideoEnabled: true,
    });

    // Local is now the main tile, so it is the local camera that decides it.
    expect(result.mainHasVideo).toBe(false);
    expect(result.pipHasVideo).toBe(true);
  });

  test('an enabled camera with no video track still has no picture', () => {
    const result = deriveCallStreams({
      ...base,
      isLocalPrimary: false,
      localStream: null,
      remoteStream: makeAudioOnlyStream('remote://1'),
      remoteVideoEnabled: true,
    });

    expect(result.mainHasVideo).toBe(false);
  });

  test('defaults to on, so a peer that never sends the flag behaves as before', () => {
    const result = deriveCallStreams({
      ...base,
      isLocalPrimary: false,
      localStream: makeVideoStream('local://1'),
      remoteStream: makeVideoStream('remote://1'),
    });

    expect(result.mainHasVideo).toBe(true);
    expect(result.pipHasVideo).toBe(true);
  });
});
