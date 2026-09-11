/**
 * Direct tests for the answer-stage clock.
 *
 * The module exists to answer "how long did that step take" for steps that sit
 * inside the server's `accepted → in_call` window, so the cases that matter are
 * the ones where an honest answer is unavailable: an untracked call, a clock
 * that moved backwards, and a call that was never cleaned up.
 */

import {
  beginAnswerTimeline,
  endAnswerTimeline,
  isAnswerTimelineActive,
  markAnswerStage,
  resetAnswerTimelines,
} from '../../src/call/answerTimeline';

beforeEach(() => {
  resetAnswerTimelines();
});

describe('markAnswerStage', () => {
  it('reports the stage on its own and the elapsed time since the accept', () => {
    beginAnswerTimeline('call-1', 1_000);

    expect(markAnswerStage('call-1', 1_400)).toEqual({ stageMs: 400, sinceAcceptMs: 400 });
    // The second stage is measured from the first, not from the accept.
    expect(markAnswerStage('call-1', 2_000)).toEqual({ stageMs: 600, sinceAcceptMs: 1_000 });
  });

  it('returns null for a call that is not being timed, rather than a zero', () => {
    expect(markAnswerStage('call-unknown', 1_000)).toBeNull();
    beginAnswerTimeline('call-1', 1_000);
    expect(markAnswerStage('call-2', 1_500)).toBeNull();
  });

  it('returns null for a missing callId', () => {
    expect(markAnswerStage(null, 1_000)).toBeNull();
    expect(markAnswerStage(undefined, 1_000)).toBeNull();
  });

  it('clamps a clock that went backwards instead of reporting a negative stage', () => {
    beginAnswerTimeline('call-1', 5_000);

    expect(markAnswerStage('call-1', 4_000)).toEqual({ stageMs: 0, sinceAcceptMs: 0 });
  });
});

describe('beginAnswerTimeline', () => {
  it('restarts the clock when an accept is retried', () => {
    beginAnswerTimeline('call-1', 1_000);
    beginAnswerTimeline('call-1', 3_000);

    expect(markAnswerStage('call-1', 3_250)).toEqual({ stageMs: 250, sinceAcceptMs: 250 });
  });

  it('ignores a missing callId', () => {
    beginAnswerTimeline(null, 1_000);
    beginAnswerTimeline('', 1_000);

    expect(isAnswerTimelineActive(null)).toBe(false);
    expect(isAnswerTimelineActive('')).toBe(false);
  });

  it('evicts the oldest answer rather than refusing to track the newest', () => {
    for (const id of ['a', 'b', 'c', 'd']) beginAnswerTimeline(id, 1_000);
    beginAnswerTimeline('e', 1_000);

    // A call that died between stages must not be able to stop the live one
    // being measured.
    expect(isAnswerTimelineActive('a')).toBe(false);
    expect(isAnswerTimelineActive('e')).toBe(true);
    expect(markAnswerStage('e', 1_100)?.stageMs).toBe(100);
  });
});

describe('endAnswerTimeline', () => {
  it('stops timing, so later stages report no duration', () => {
    beginAnswerTimeline('call-1', 1_000);
    endAnswerTimeline('call-1');

    expect(isAnswerTimelineActive('call-1')).toBe(false);
    expect(markAnswerStage('call-1', 1_500)).toBeNull();
  });

  it('tolerates a call that was never tracked', () => {
    expect(() => endAnswerTimeline('call-unknown')).not.toThrow();
    expect(() => endAnswerTimeline(null)).not.toThrow();
  });
});
