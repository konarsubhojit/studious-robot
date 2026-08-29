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

describe('setTrackEnabled failure reporting', () => {
  test('reports failure when a track silently refuses the change', () => {
    const stubborn = {
      kind: 'audio',
      get enabled() {
        return true;
      },
      set enabled(_value) {
        // A native sender that ignores the write.
      },
    };
    const stream = { getTracks: () => [stubborn] };
    expect(setTrackEnabled(stream as any, 'audio', false)).toBe(false);
  });

  test('reports failure when the setter throws instead of muting', () => {
    const throwing = {
      kind: 'audio',
      get enabled() {
        return true;
      },
      set enabled(_value) {
        throw new Error('track ended');
      },
    };
    const stream = { getTracks: () => [throwing] };
    expect(setTrackEnabled(stream as any, 'audio', false)).toBe(false);
  });

  test('reports success once every track of the kind carries the new state', () => {
    const tracks = [
      { kind: 'audio', enabled: true },
      { kind: 'audio', enabled: true },
      { kind: 'video', enabled: true },
    ];
    const stream = { getTracks: () => tracks };
    expect(setTrackEnabled(stream as any, 'audio', false)).toBe(true);
    expect(tracks.map(track => track.enabled)).toEqual([false, false, true]);
  });
});
