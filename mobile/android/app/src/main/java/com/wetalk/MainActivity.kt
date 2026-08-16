package com.wetalk

import android.app.KeyguardManager
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.WindowManager
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

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    applyIncomingCallWakeFlags(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    applyIncomingCallWakeFlags(intent)
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
   * dismiss with no real call in progress. Guard against that by requiring a
   * real, currently-live react-native-callkeep connection for the intent's
   * `callId`, the same check [IncomingCallActionReceiver] already performs
   * before acting on a notification action.
   */
  private fun applyIncomingCallWakeFlags(intent: Intent?) {
    if (intent?.getBooleanExtra(EXTRA_INCOMING_CALL, false) != true) return
    val callId = intent.data?.lastPathSegment ?: return
    if (!CallConnections.isLive(callId)) return

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
    /**
     * Intent extra set by [IncomingCallNotificationModule]'s full-screen intent
     * so [applyIncomingCallWakeFlags] knows to wake the device / draw over the
     * lock screen. Not set by the ordinary `wetalk://call/{callId}` deep link
     * used for a plain notification tap.
     */
    const val EXTRA_INCOMING_CALL = "com.wetalk.EXTRA_INCOMING_CALL"
  }
}
