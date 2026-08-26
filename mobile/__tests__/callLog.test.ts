import {
  CALL_FILTERS,
  callDirectionIcon,
  callMediaIcon,
  callMediaType,
  callPeerId,
  describeCallEntryForA11y,
  describeCallOutcome,
  filterCallLog,
  formatCallDayHeading,
  formatCallTimeOfDay,
  groupCallsByDay,
  isMissedCall,
} from '../src/callLog';


/** @param overrides */
const entry = (overrides: any = {}): any => ({
  callId: 'call-1',
  callerId: 'alice',
  calleeId: 'bob',
  direction: 'outgoing',
  status: 'ended',
  endReason: 'ended',
  createdAt: '2026-08-25T10:30:00.000Z',
  durationSeconds: 65,
  isRead: true,
  ...overrides,
});

describe('isMissedCall', () => {
  test('an unanswered incoming call is missed', () => {
    expect(isMissedCall(entry({ direction: 'incoming', status: 'missed' }))).toBe(true);
    expect(
      isMissedCall(entry({ direction: 'incoming', status: 'ended', endReason: 'timeout' })),
    ).toBe(true);
  });

  test('an unanswered outgoing call is not missed', () => {
    // The *other* side missed it; counting it here would inflate the badge.
    expect(
      isMissedCall(entry({ direction: 'outgoing', status: 'missed', endReason: 'timeout' })),
    ).toBe(false);
  });

  test('a completed incoming call is not missed', () => {
    expect(isMissedCall(entry({ direction: 'incoming', status: 'ended' }))).toBe(false);
  });
});

describe('callPeerId', () => {
  test('is the callee for an outgoing call and the caller for an incoming one', () => {
    expect(callPeerId(entry({ direction: 'outgoing' }))).toBe('bob');
    expect(callPeerId(entry({ direction: 'incoming' }))).toBe('alice');
  });

  test('degrades to an empty string rather than undefined', () => {
    expect(callPeerId(entry({ direction: 'outgoing', calleeId: undefined }))).toBe('');
  });
});

describe('call modality', () => {
  test('uses the recorded modality when the device has one', () => {
    expect(callMediaType(entry({ mediaType: 'audio' }))).toBe('audio');
    expect(callMediaIcon(entry({ mediaType: 'audio' }))).toBe('callTypeAudio');
  });

  test('falls back to video, matching what redial will actually do', () => {
    expect(callMediaType(entry())).toBe('video');
    expect(callMediaIcon(entry())).toBe('callTypeVideo');
  });
});

describe('callDirectionIcon', () => {
  test('distinguishes missed, incoming and outgoing', () => {
    expect(callDirectionIcon(entry({ direction: 'incoming', status: 'missed' }))).toBe(
      'callMissed',
    );
    expect(callDirectionIcon(entry({ direction: 'incoming' }))).toBe('callIncoming');
    expect(callDirectionIcon(entry({ direction: 'outgoing' }))).toBe('callOutgoing');
  });
});

describe('describeCallOutcome', () => {
  test('prefers the recorded end reason', () => {
    expect(describeCallOutcome(entry({ endReason: 'declined' }))).toBe('Call declined');
  });

  test('never degrades to a bare "Call"', () => {
    const outcome = describeCallOutcome(
      entry({ endReason: undefined, status: undefined, direction: 'incoming' }),
    );
    expect(outcome).toBe('Incoming');
  });
});

describe('formatCallTimeOfDay', () => {
  test('is empty for a missing or unparseable timestamp', () => {
    expect(formatCallTimeOfDay(null)).toBe('');
    expect(formatCallTimeOfDay('not a date')).toBe('');
  });

  test('renders a time for a valid timestamp', () => {
    expect(formatCallTimeOfDay('2026-08-25T10:30:00.000Z')).not.toBe('');
  });
});

describe('formatCallDayHeading', () => {
  const now = new Date(2026, 7, 25, 12, 0, 0);

  test('names today and yesterday', () => {
    expect(formatCallDayHeading(new Date(2026, 7, 25, 1, 0, 0), now)).toBe('Today');
    expect(formatCallDayHeading(new Date(2026, 7, 24, 23, 0, 0), now)).toBe('Yesterday');
  });

  test('a call later today is still today, not tomorrow', () => {
    // Clock skew between device and server must not produce a future heading.
    expect(formatCallDayHeading(new Date(2026, 7, 25, 23, 59, 0), now)).toBe('Today');
  });

  test('uses a weekday name within the past week and a date beyond it', () => {
    const weekday = formatCallDayHeading(new Date(2026, 7, 21, 9, 0, 0), now);
    expect(weekday).not.toBe('Today');
    expect(weekday).not.toBe('Yesterday');

    const older = formatCallDayHeading(new Date(2026, 6, 1, 9, 0, 0), now);
    expect(older).not.toBe(weekday);
  });
});

describe('filterCallLog', () => {
  const history = [
    entry({ callId: 'a', direction: 'outgoing' }),
    entry({ callId: 'b', direction: 'incoming', status: 'missed' }),
  ];

  test('All keeps everything', () => {
    expect(filterCallLog(history, CALL_FILTERS.ALL)).toHaveLength(2);
  });

  test('Missed keeps only calls the local user missed', () => {
    const missed = filterCallLog(history, CALL_FILTERS.MISSED);
    expect(missed.map(e => e.callId)).toEqual(['b']);
  });

  test('tolerates a missing history', () => {
    expect(filterCallLog(undefined, CALL_FILTERS.ALL)).toEqual([]);
    expect(filterCallLog(null, CALL_FILTERS.MISSED)).toEqual([]);
  });
});

describe('groupCallsByDay', () => {
  const now = new Date(2026, 7, 25, 12, 0, 0);

  test('groups by calendar day, newest day first', () => {
    const sections = groupCallsByDay(
      [
        entry({ callId: 'older', createdAt: new Date(2026, 7, 23, 9, 0, 0).toISOString() }),
        entry({ callId: 'today-1', createdAt: new Date(2026, 7, 25, 9, 0, 0).toISOString() }),
        entry({ callId: 'today-2', createdAt: new Date(2026, 7, 25, 11, 0, 0).toISOString() }),
      ],
      now,
    );

    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe('Today');
    expect(sections[0].entries.map(e => e.callId)).toEqual(['today-1', 'today-2']);
    expect(sections[1].entries.map(e => e.callId)).toEqual(['older']);
  });

  test('keeps undated calls under a trailing section instead of dropping them', () => {
    const sections = groupCallsByDay(
      [
        entry({ callId: 'undated', createdAt: null }),
        entry({ callId: 'today', createdAt: new Date(2026, 7, 25, 9, 0, 0).toISOString() }),
      ],
      now,
    );

    expect(sections.map(s => s.title)).toEqual(['Today', 'Earlier']);
    expect(sections[1].entries.map(e => e.callId)).toEqual(['undated']);
  });

  test('section keys are unique, so a SectionList can key off them', () => {
    const sections = groupCallsByDay(
      [
        entry({ callId: '1', createdAt: new Date(2026, 7, 25, 9, 0, 0).toISOString() }),
        entry({ callId: '2', createdAt: new Date(2026, 7, 24, 9, 0, 0).toISOString() }),
        entry({ callId: '3', createdAt: new Date(2026, 7, 25, 22, 0, 0).toISOString() }),
      ],
      now,
    );
    const keys = sections.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('tolerates a missing history', () => {
    expect(groupCallsByDay(undefined, now)).toEqual([]);
  });
});

describe('describeCallEntryForA11y', () => {
  test('reads as one sentence covering modality, outcome, peer, time and duration', () => {
    const sentence = describeCallEntryForA11y(
      entry({ direction: 'incoming', status: 'missed', endReason: 'timeout', mediaType: 'audio' }),
      '01:05',
    );
    expect(sentence).toContain('Audio call');
    expect(sentence).toContain('Missed call');
    expect(sentence).toContain('with alice');
    expect(sentence).toContain('01:05');
  });

  test('names an unknown contact rather than leaving a gap', () => {
    const sentence = describeCallEntryForA11y(
      entry({ direction: 'outgoing', calleeId: undefined }),
      '',
    );
    expect(sentence).toContain('Unknown contact');
  });
});
