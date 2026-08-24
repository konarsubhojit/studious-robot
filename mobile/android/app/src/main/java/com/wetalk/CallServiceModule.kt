package com.wetalk

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Native bridge that lets JavaScript start/stop the call foreground service and
 * request Picture-in-Picture mode for the current activity.
 */
class CallServiceModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  @ReactMethod
  fun startService() {
    val intent = Intent(reactContext, CallForegroundService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      reactContext.startForegroundService(intent)
    } else {
      reactContext.startService(intent)
    }
    isCallActive = true
    refreshPictureInPictureParams()
  }

  @ReactMethod
  fun stopService() {
    isCallActive = false
    refreshPictureInPictureParams()
    val intent = Intent(reactContext, CallForegroundService::class.java)
    reactContext.stopService(intent)
  }

  /**
   * Ask the current [MainActivity] to re-sync its Picture-in-Picture params with
   * the new call state so Android 12+ auto-enter reflects whether a call is
   * active. Runs on the UI thread; no-ops when the activity is unavailable.
   */
  private fun refreshPictureInPictureParams() {
    val activity = reactApplicationContext.currentActivity as? MainActivity ?: return
    activity.runOnUiThread { activity.updatePictureInPictureParams() }
  }

  /**
   * Record the current microphone state so the Picture-in-Picture window's
   * mute control shows the right icon and label, and re-publish the params so a
   * mute toggle made from the full-screen deck is reflected immediately in an
   * already-open PiP window.
   */
  @ReactMethod
  fun setPictureInPictureMuted(muted: Boolean) {
    if (isMicrophoneMuted == muted) return
    isMicrophoneMuted = muted
    refreshPictureInPictureParams()
  }

  /**
   * Ask the activity to enter Picture-in-Picture, resolving whether it did.
   *
   * Deliberately never rejects: the request used to be issued from a JS
   * `AppState` background transition, by which point the activity is no longer
   * resumed and Android throws
   * `IllegalStateException: Activity must be resumed to enter picture-in-picture`.
   * PiP is now entered natively from `MainActivity.onUserLeaveHint()` (and by
   * Android 12+ auto-enter); this method remains for explicit requests and
   * reports the reason it could not be honoured instead of failing the call.
   */
  @ReactMethod
  fun enterPictureInPictureMode(promise: Promise) {
    val activity = reactApplicationContext.currentActivity as? MainActivity
    if (activity == null) {
      Log.w(TAG, "Picture-in-Picture request skipped reason=no-activity")
      promise.resolve(false)
      return
    }

    activity.runOnUiThread {
      val reason =
        try {
          activity.requestPictureInPicture()
        } catch (error: Exception) {
          error.message ?: error.javaClass.simpleName
        }
      if (reason != null) {
        Log.w(TAG, "Picture-in-Picture request skipped reason=$reason")
      }
      promise.resolve(reason == null)
    }
  }

  /**
   * Leave Picture-in-Picture mode.
   *
   * Android exposes no "exit PiP" API: the only supported way out is to bring
   * the activity back to the front, which the system then restores to full
   * screen. Without this, a call that ends while in PiP leaves the window on
   * screen showing the last decoded frame of a torn-down stream — updating the
   * PiP params only disables *future* auto-enter.
   */
  @ReactMethod
  fun exitPictureInPictureMode(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false)
      return
    }
    if (!activity.isInPictureInPictureMode) {
      promise.resolve(false)
      return
    }

    try {
      val intent =
        Intent(reactApplicationContext, MainActivity::class.java).apply {
          addFlags(
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
              Intent.FLAG_ACTIVITY_SINGLE_TOP or
              Intent.FLAG_ACTIVITY_NEW_TASK,
          )
        }
      activity.startActivity(intent)
      Log.i(TAG, "Left Picture-in-Picture mode")
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("PIP_EXIT_ERROR", error)
    }
  }

  companion object {
    const val NAME = "CallService"

    private const val TAG = "WeTalkCallService"

    /** Event emitted to JS whenever the activity enters or leaves PiP. */
    const val EVENT_PIP_MODE_CHANGED = "CallService.pictureInPictureModeChanged"

    /**
     * Bridge a native Picture-in-Picture mode change to JS.
     *
     * JS previously inferred PiP state from `AppState` alone, which desyncs as
     * soon as the system enters or leaves PiP on its own (auto-enter, the
     * window's expand button, or the user closing the window).
     *
     * @param dismissed True when PiP was left because the window was closed
     *   (the activity is stopping) rather than restored to full screen.
     */
    @JvmStatic
    fun emitPictureInPictureModeChanged(
      context: Context,
      isInPictureInPictureMode: Boolean,
      dismissed: Boolean,
    ) {
      val params =
        Arguments.createMap().apply {
          putBoolean("isInPictureInPictureMode", isInPictureInPictureMode)
          putBoolean("dismissed", dismissed)
        }
      emitEvent(context, EVENT_PIP_MODE_CHANGED, params)
    }

    /** Emit [event] to JS, no-oping when no React context is available yet. */
    private fun emitEvent(
      context: Context,
      event: String,
      params: WritableMap,
    ) {
      val reactContext: ReactContext =
        (context.applicationContext as? ReactApplication)
          ?.reactHost
          ?.currentReactContext ?: return
      try {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(event, params)
      } catch (error: Exception) {
        Log.w(TAG, "Failed to emit $event", error)
      }
    }

    /** Event emitted to JS whenever a Picture-in-Picture window control is tapped. */
    const val EVENT_PIP_ACTION = "CallService.pictureInPictureAction"

    /**
     * Bridge a tap on one of the Picture-in-Picture window's controls to JS.
     *
     * A PiP window cannot deliver touches to the app's own views, so these
     * system-drawn controls are the only way to mute or hang up without
     * restoring the app to full screen.
     *
     * @param control One of `MainActivity.CONTROL_MUTE` / `CONTROL_HANG_UP`.
     */
    @JvmStatic
    fun emitPictureInPictureAction(
      context: Context,
      control: String,
    ) {
      val params = Arguments.createMap().apply { putString("control", control) }
      emitEvent(context, EVENT_PIP_ACTION, params)
    }

    /** Aspect ratio (width:height) used for the Picture-in-Picture window (portrait). */
    const val PIP_ASPECT_RATIO_WIDTH = 9
    const val PIP_ASPECT_RATIO_HEIGHT = 16

    /** Set while a call is active so the activity can enter PiP on user leave. */
    @Volatile
    var isCallActive: Boolean = false

    /**
     * Latest microphone state reported by JS, used to label the PiP window's
     * mute control. Only ever read on the UI thread when building PiP params,
     * but written from the JS thread — hence `@Volatile`.
     */
    @Volatile
    var isMicrophoneMuted: Boolean = false
  }
}
