import {
  describeOffline,
  OFFLINE_CONSEQUENCE,
  OFFLINE_ICON,
  OFFLINE_LEAD,
} from '../src/connectivityUx';

describe('connectivityUx', () => {
  test('every offline sentence opens with the same lead', () => {
    Object.values(OFFLINE_CONSEQUENCE).forEach(consequence => {
      expect(describeOffline(consequence).startsWith(`${OFFLINE_LEAD} — `)).toBe(true);
    });
  });

  test('each surface states a different consequence', () => {
    const consequences = Object.values(OFFLINE_CONSEQUENCE);

    expect(new Set(consequences).size).toBe(consequences.length);
  });

  test('composes the lead and the consequence into one sentence', () => {
    expect(describeOffline(OFFLINE_CONSEQUENCE.conversation)).toBe(
      "Offline — messages will send when you're back",
    );
  });

  test('names one icon for every offline banner', () => {
    expect(OFFLINE_ICON).toBe('offline');
  });

  test('no consequence re-states the lead, which would read as "Offline — offline…"', () => {
    Object.values(OFFLINE_CONSEQUENCE).forEach(consequence => {
      expect(consequence.toLowerCase().startsWith('offline')).toBe(false);
    });
  });
});
