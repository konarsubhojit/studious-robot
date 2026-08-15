# UI Revamp — Next Steps

Tracking document for the WeTalk mobile UI revamp requested alongside the
safe-area / keyboard / permissions fixes already shipped. Use this as the
starting checklist for the next session.

## Already done (this round)

- [x] Bottom tab bar (Chats/Calls/Settings) no longer overlaps the Android
      gesture-navigation bar (`react-native-safe-area-context` +
      `AppTabBar` bottom inset padding).
- [x] Chat composer stays visible above the keyboard; send button reachable
      without dismissing the keyboard first (`KeyboardAvoidingView`
      behavior fix + auto-scroll-to-bottom + `keyboardShouldPersistTaps`).
- [x] All Android runtime permissions (camera, mic, Bluetooth, call log,
      notifications) requested once, up front, right after identity is
      established, instead of only lazily on first call.

## Open items for the next revamp pass

### Chat conversation screen (see reference screenshot)
- [x] Increase spacing/contrast between consecutive own-message bubbles vs.
      the peer's — bubbles currently read a little flat against the dark
      background; consider a subtle border or shadow on own-bubbles.
- [x] Timestamp + single/double tick row is easy to miss (small, muted
      grey) — consider slightly larger tick glyphs or a clearer "read"
      color state.
- [x] Composer input is a plain single-line-looking pill; add a subtle
      focus-state border/elevation change so it's obvious it's active
      once tapped.
- [x] Header presence text ("Offline"/"Online") could use a colored dot
      (green/grey) matching the existing `presenceOnline`/`presenceOffline`
      icons already defined in `vectorIcons.js`, instead of text only.
- [x] Add a scroll-to-bottom "new message" FAB when the user has scrolled
      up and a new message arrives (currently auto-scroll only triggers
      the jump; there's no manual affordance if auto-scroll is skipped
      because the user is mid-read of older history).

### Calls tab / Lobby
- [x] Revisit call history row density and iconography for consistency
      with the new tab-bar icon set (`tabCalls`/`tabCallsActive`).
- [x] Audit touch target sizes on redial/contact rows against the same
      "too small" complaint that prompted the tab-bar fix.

### In-call screen (`CallScreen`)
- [x] Verify `bottomOverlay` call controls respect the bottom safe-area
      inset on devices with gesture navigation — confirmed via code
      inspection: the app-level root container (`App.js`) already pads its
      bottom edge by `insets.bottom` whenever a non-compact `CallScreen` is
      shown (documented with a comment in `CallScreen.js`). **Still needs
      real-device confirmation**, which could not be performed in this
      sandbox.
- [x] Consider larger, more discoverable control icons/labels during a
      call, consistent with the "too small" feedback. Mute/video/leave now
      show visible text labels (matching Accept/Decline/Cancel elsewhere)
      and all in-call control icons were enlarged (52dp → 56dp, leave
      64dp).

### Settings screen
- [x] General visual pass for consistency with the refreshed tab bar
      (spacing, section headers, icon usage).

### Cross-cutting
- [ ] Real-device QA pass (cold start, locked screen, gesture nav vs.
      3-button nav, various keyboard types/IMEs) — could not be performed
      in this sandboxed environment for either the CallKeep or this UI
      work; required before shipping. **Still open** after this revamp
      pass (Phases 1–4 above are code-complete and test-covered, but the
      in-call safe-area fix and general layout still need a real device).
- [ ] Confirm no double-padding/layout regressions on tablets or
      split-screen (the safe-area insets change touches the whole app
      shell). **Still open** for the same reason.
