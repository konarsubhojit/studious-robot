# Grumpy Code Review — copilot/fix-ringing-issue-on-caller-side vs master

_Reviewed fbfed10..HEAD, 11 files changed (5 source, 1 native, 5 test)._

## Summary

Mergeable, with two things I want fixed first. The shape of the change is right:
the caller no longer starts an InCallManager session just to play itself a
ringback, the receiving side finally asks the OS what the ringer is set to, and
unmuting re-asserts the in-call session. But the ringer read was dropped
straight onto the *latency-critical* incoming-call path (it now sits between
"call.incoming arrived" and "show the incoming-call UI"), and the audio-session
restore is a floating promise with a `.then()` and no `.catch()` on a function
that can genuinely reject. Both are small fixes; neither is a redesign.

## Findings

### Critical

None.

### High

- **[HIGH] A native round-trip now blocks the incoming-call UI** —
  `mobile/src/hooks/useCallFlow.ts:1768-1780`
  - `showIncomingCallUi` `await`s `shouldVibrateForRing()` (a bridge call into
    `IncomingCallNotification.getRingerMode`) *before* `displayIncomingCall` is
    even requested. Every incoming call now waits on a native promise before
    any UI or CallKeep display is asked for, and if the bridge is slow (cold
    start, busy JS thread — exactly the conditions of a push-woken call) the
    ringing UI is delayed by that much.
  - Why it matters: the whole point of this path is to alert the user as fast
    as possible; the haptic is a garnish and must not gate the UI.
  - Fix: request the incoming-call UI first (or start the ringer-mode read
    without awaiting it), and fire the haptic when the answer arrives.

### Medium

- **[MEDIUM] Unhandled rejection on the unmute path** —
  `mobile/src/hooks/useCallFlow.ts:3538-3546`
  - `restoreInCallAudioSession(...)` is called fire-and-forget with a `.then()`
    and no `.catch()`. It is not rejection-proof: it delegates to
    `chooseAudioRoute`, whose `ensureBluetoothPermission(...)` call sits
    *outside* that function's `try`, so a throwing permission check rejects the
    whole chain. A Bluetooth call where the permission module throws turns an
    unmute into an unhandled promise rejection.
  - Why it matters: unhandled rejections are noisy at best and fatal on strict
    RN setups; the surrounding code style is "never throw, log and degrade".
  - Fix: add a `.catch()` that logs, matching the `logWarn` already used for a
    failed result.

### Low

- **[LOW] `restoreInCallAudioSession` returns a differently-shaped error than its neighbours** —
  `mobile/src/audioRouting.ts:114-127`
  - `startAudioSession`/`stopAudioSession` return `{ ok: false; error: unknown; message }`
    with `error` always present; this one declares `error?: unknown`, so
    callers pattern-matching on the module's result type see two shapes.
  - Why it matters: minor, but the module is otherwise rigidly consistent.
  - Fix: acceptable as-is (the route-failure branch genuinely may have no
    `error`), but worth a comment saying so.

### Nit

- **[NIT] Ringer-mode constants live in two places** —
  `mobile/src/ringerMode.ts:18-24` and
  `mobile/android/app/src/main/java/com/wetalk/IncomingCallNotificationModule.kt:343-345`
  - The three strings are declared on both sides of the bridge. Both sides
    carry a comment pointing at the other, which is the best that can be done
    without a codegen step, so this is noted, not graded.

## Resolution

All Critical/High/Medium findings above were fixed in the same branch: the
ringer read no longer gates the incoming-call UI (the haptic now fires from a
non-blocking promise), the unmute restore has a `.catch()`, and the differing
error shape is documented. No Critical/High/Medium findings remain open; only
the Nit above.

## Out of scope (pre-existing, not graded)

- `stopIncomingRingtone()` calls `InCallManager.stop()`, which tears down the
  *whole* audio session rather than just the ringtone. Harmless in today's
  flows (it always runs before the in-call session starts), but it would bite a
  future call-waiting feature. Untouched by this diff.
- `chooseAudioRoute` performs its Bluetooth permission check outside its
  `try`/`catch` — pre-existing, and the reason for the Medium finding above.
