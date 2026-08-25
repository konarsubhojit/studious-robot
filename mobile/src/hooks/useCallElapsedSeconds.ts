import { useEffect, useState } from 'react';

/**
 * Seconds elapsed since a call connected, ticked locally by whichever component
 * displays the duration.
 *
 * Why this is a hook and not a field on the call flow: the elapsed second is
 * the only piece of call state that changes on a timer rather than in response
 * to a user action or a server event. When it lived in `useCallFlow` it was
 * re-rendering the entire application once per second for the whole duration of
 * every call — `useCallFlow` returns a fresh object on every render, which
 * changes the `CallProvider` context identity, which changes the `ChatProvider`
 * context derived from it, which re-renders every mounted screen including an
 * open conversation and its list of message bubbles.
 *
 * Keeping the tick here means the timer never crosses a provider boundary: the
 * call flow publishes only `callConnectedAtMs` — a value that changes exactly
 * twice per call — and the two or three components that actually render a
 * duration each own their own interval.
 *
 * @param callConnectedAtMs - Epoch milliseconds at which the call connected, or
 *   `null` when no call is connected.
 * @returns Whole seconds since the call connected; `0` when there is no call.
 */
export default function useCallElapsedSeconds(callConnectedAtMs: number | null): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    callConnectedAtMs ? elapsedSince(callConnectedAtMs) : 0,
  );

  useEffect(() => {
    if (!callConnectedAtMs) {
      setElapsedSeconds(0);
      return undefined;
    }

    // Re-sync immediately rather than waiting a full second: the call may have
    // connected before this component mounted (restoring a minimized call, or
    // rehydrating from a push), in which case starting from 0 would show a
    // duration that visibly disagrees with the one the user just saw.
    setElapsedSeconds(elapsedSince(callConnectedAtMs));

    const timer = setInterval(() => {
      setElapsedSeconds(elapsedSince(callConnectedAtMs));
    }, 1000);

    return () => clearInterval(timer);
  }, [callConnectedAtMs]);

  return elapsedSeconds;
}

/**
 * Whole seconds between `startedAtMs` and now, never negative.
 *
 * A device clock adjustment mid-call can move `Date.now()` behind the recorded
 * start, which would otherwise render as a negative duration.
 */
function elapsedSince(startedAtMs: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
}
