package com.wetalk

import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.WindowManager
import androidx.lifecycle.Lifecycle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "WeTalk"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Passes `null` to `super.onCreate` (instead of forwarding
   * `savedInstanceState`) as react-native-screens requires: it stops Android
   * from restoring the native fragment hierarchy of a killed process, which
   * would otherwise leave stale/crashing screens behind when React Navigation
   * re-creates them. Navigation state is restored from JS instead — see
   * `mobile/src/navigation/navigationState.js`.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    handleIncomingCallIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIncomingCallIntent(intent)
  }

  /**
   * Handle a launch from WeTalk's branded incoming-call notification: record
   * an Accept tap for the JS call flow to replay, then apply the wake flags.
   *
   * The Accept action's `PendingIntent` targets this Activity directly (see
   * `IncomingCallNotificationModule.acceptPendingIntent`), so accepting never
   * depends on a live CallKeep `Connection` — on a cold start Telecom often
   * never created one, which previously made the Accept button a silent no-op.
   * `Connection.onAnswer()` is still called when a connection *does* exist, so
   * the OS call UI transitions correctly, but its absence is only logged.
   */
  private fun handleIncomingCallIntent(intent: Intent?) {
    if (intent?.getBooleanExtra(EXTRA_INCOMING_CALL, false) != true) return
    val callId = intent.data?.lastPathSegment
    if (callId.isNullOrBlank()) {
      Log.w(TAG, "Incoming-call intent without a callId; ignoring")
      return
    }

    val accepted = intent.getBooleanExtra(EXTRA_ACCEPT_CALL, false)
    if (accepted) {
      // Consume the extra so a later re-delivery of the same intent (e.g. a
      // configuration change re-creating the Activity) cannot answer twice.
      intent.removeExtra(EXTRA_ACCEPT_CALL)
      (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
        ?.cancel(IncomingCallNotificationModule.notificationId(callId))
      val connectionLive = CallConnections.answer(callId)
      Log.i(TAG, "Accept tapped callId=$callId connectionLive=$connectionLive")
      // Persist the tap: the JS pending-answer queue lives in a JS module and
      // does not survive process death, so a cold-start accept is replayed
      // from here by `useCallFlow` on mount.
      PendingCallStore.recordAction(
        this,
        callId,
        PendingCallStore.ACTION_ACCEPT,
        connectionLive,
      )
    }

    applyIncomingCallWakeFlags(callId)

    if (accepted) {
      // The call is no longer ringing, so the record must stop vouching for
      // incoming-call intents (it is only a trust signal for the wake flags
      // applied just above).
      PendingCallStore.clearRinging(this, callId)
    }
  }

  /**
   * Wake the device and draw over the lock screen when launched from WeTalk's
   * branded incoming-call notification (`IncomingCallNotificationModule`'s
   * full-screen intent). Without this the notification can still ring the
   * device, but tapping it (or the system auto-launching it while locked)
   * would leave the branded incoming-call screen stuck behind the lock
   * screen instead of showing it, defeating the point of the full-screen
   * intent.
   *
   * `MainActivity` is exported (required for the launcher icon) and already
   * accepts external `wetalk://call/{callId}` deep links, so [EXTRA_INCOMING_CALL]
   * alone — a plain `Intent` extra, not covered by the intent-filter — cannot
   * be trusted: any other app could forge it to force a screen wake / keyguard
   * dismiss with no real call in progress. The intent is therefore accepted
   * only for a call this app is itself ringing for: either a live
   * react-native-callkeep connection, or a ringing record written by
   * [IncomingCallNotificationModule] (only this app can write those
   * preferences). The latter is what keeps the screen wake working on a cold
   * start, where Telecom frequently never completed a connection and the
   * connection-only check silently did nothing.
   */
  private fun applyIncomingCallWakeFlags(callId: String) {
    val connectionLive = CallConnections.isLive(callId)
    val ringing = PendingCallStore.isRinging(this, callId)
    if (!connectionLive && !ringing) {
      Log.w(
        TAG,
        "Ignoring incoming-call intent for unknown callId=$callId" +
          " (no live connection and not ringing)",
      )
      return
    }
    Log.i(TAG, "Waking screen for callId=$callId connectionLive=$connectionLive ringing=$ringing")

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
      )
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      keyguardManager?.requestDismissKeyguard(this, null)
    }
  }

  /**
   * Keep the Picture-in-Picture params in sync with the current call state. On
   * Android 12+ (S) this enables `autoEnterEnabled`, which makes the system move
   * the activity into PiP automatically on *any* app-leave gesture — including
   * the Back gesture/button, which never triggers [onUserLeaveHint]. Called
   * whenever the call becomes active/inactive so PiP works reliably regardless of
   * how the user leaves the screen.
   */
  fun updatePictureInPictureParams() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !supportsPictureInPicture()) {
      return
    }
    try {
      setPictureInPictureParams(buildPipParams(autoEnter = CallServiceModule.isCallActive))
    } catch (_: IllegalStateException) {
      // Activity not in a valid state to update PiP params; ignore.
    }
  }

  /**
   * Bridge the real Picture-in-Picture state to JS.
   *
   * JS used to infer PiP purely from `AppState`, which desyncs whenever the
   * system enters or leaves PiP on its own. Leaving PiP because the user closed
   * the window (the X on the PiP window) stops the activity instead of
   * restoring it, and is reported as `dismissed` so the JS layer can end the
   * call rather than leave it running invisibly.
   */
  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    val dismissed =
      !isInPictureInPictureMode &&
        (isFinishing || !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    Log.i(
      TAG,
      "PiP mode changed inPip=$isInPictureInPictureMode dismissed=$dismissed",
    )
    CallServiceModule.emitPictureInPictureModeChanged(this, isInPictureInPictureMode, dismissed)
  }

  override fun onResume() {
    super.onResume()
    // Re-apply auto-enter on resume so a call started while backgrounded (e.g.
    // answered from the system UI) still auto-enters PiP on the next app-leave.
    updatePictureInPictureParams()
  }

  /**
   * Enter Picture-in-Picture automatically when the user leaves the app (e.g. presses Home)
   * while a call is active, so the call keeps playing in a small floating window.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      CallServiceModule.isCallActive &&
      supportsPictureInPicture()
    ) {
      enterPipSafely()
    }
  }

  /**
   * The Back gesture/button does not trigger [onUserLeaveHint]. On Android 12+
   * `autoEnterEnabled` covers Back, but on Android 8–11 we must enter PiP here
   * explicitly (instead of finishing the activity) so an active call keeps
   * running in a floating window when the user navigates back.
   */
  @Deprecated("Deprecated in Java")
  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O until Build.VERSION_CODES.S &&
      CallServiceModule.isCallActive &&
      supportsPictureInPicture() &&
      enterPipSafely()
    ) {
      return
    }
    super.onBackPressed()
  }

  /** Whether this device advertises Picture-in-Picture support. */
  private fun supportsPictureInPicture(): Boolean =
    packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  /** Build PiP params, enabling auto-enter on Android 12+ when requested. */
  private fun buildPipParams(autoEnter: Boolean): PictureInPictureParams {
    val builder =
      PictureInPictureParams
        .Builder()
        .setAspectRatio(
          Rational(
            CallServiceModule.PIP_ASPECT_RATIO_WIDTH,
            CallServiceModule.PIP_ASPECT_RATIO_HEIGHT,
          ),
        )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(autoEnter)
    }
    return builder.build()
  }

  /** Enter PiP, swallowing device/OEM failures. Returns true when entered. */
  private fun enterPipSafely(): Boolean =
    try {
      enterPictureInPictureMode(buildPipParams(autoEnter = false))
    } catch (_: IllegalStateException) {
      false
    } catch (_: IllegalArgumentException) {
      false
    }

  companion object {
    private const val TAG = "WeTalkMainActivity"

    /**
     * Intent extra marking a launch that came from the notification's Accept
     * button, so the tap is recorded for the JS call flow to complete.
     */
    const val EXTRA_ACCEPT_CALL = "com.wetalk.EXTRA_ACCEPT_CALL"

    /**
     * Intent extra set by [IncomingCallNotificationModule]'s full-screen intent
     * so [applyIncomingCallWakeFlags] knows to wake the device / draw over the
     * lock screen. Not set by the ordinary `wetalk://call/{callId}` deep link
     * used for a plain notification tap.
     */
    const val EXTRA_INCOMING_CALL = "com.wetalk.EXTRA_INCOMING_CALL"
  }
}
