// @ts-check
import { deriveCallStreams } from '../src/callStreamHelpers';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

jest.mock('../src/diagnostics', () => ({
  getStreamUrl: jest.fn((stream, context) => {
    if (!stream || typeof stream.toURL !== 'function') return null;
    try {
      return stream.toURL();
    } catch {
      return null;
    }
  }),
}));

function makeStream(/** @type {string} */ url: string) {
  return { toURL: () => url };
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
