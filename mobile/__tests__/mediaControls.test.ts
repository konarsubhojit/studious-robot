import { isTrackEnabled, setTrackEnabled } from '../src/mediaControls';

function createStream() {
  const tracks = [
    { kind: 'audio', enabled: true },
    { kind: 'video', enabled: true },
  ];

  return {
    tracks,
    getTracks: () => tracks,
  };
}

describe('mediaControls', () => {
  test('setTrackEnabled toggles all tracks for the requested kind', () => {
    const stream = createStream();

    expect(setTrackEnabled(stream, 'audio', false)).toBe(true);
    expect(stream.tracks[0].enabled).toBe(false);
    expect(stream.tracks[1].enabled).toBe(true);
  });

  test('isTrackEnabled reflects the first track state for a kind', () => {
    const stream = createStream();

    expect(isTrackEnabled(stream, 'video')).toBe(true);
    setTrackEnabled(stream, 'video', false);
    expect(isTrackEnabled(stream, 'video')).toBe(false);
  });

  test('returns false when stream or track kind is unavailable', () => {
    expect(setTrackEnabled(null, 'audio', false)).toBe(false);
    expect(isTrackEnabled(null, 'audio')).toBe(false);

    const stream = createStream();
    expect(setTrackEnabled(stream, 'screen', false)).toBe(false);
    expect(isTrackEnabled(stream, 'screen')).toBe(false);
  });
});
