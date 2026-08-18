package com.wetalk

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import android.util.Rational
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
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

  @ReactMethod
  fun enterPictureInPictureMode(promise: Promise) {
    val activity: Activity? = reactApplicationContext.currentActivity
    if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false)
      return
    }

    try {
      val params =
        PictureInPictureParams
          .Builder()
          .setAspectRatio(Rational(PIP_ASPECT_RATIO_WIDTH, PIP_ASPECT_RATIO_HEIGHT))
          .build()
      val entered = activity.enterPictureInPictureMode(params)
      promise.resolve(entered)
    } catch (error: Exception) {
      promise.reject("PIP_ERROR", error)
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
      val reactContext: ReactContext =
        (context.applicationContext as? ReactApplication)
          ?.reactHost
          ?.currentReactContext ?: return
      val params =
        Arguments.createMap().apply {
          putBoolean("isInPictureInPictureMode", isInPictureInPictureMode)
          putBoolean("dismissed", dismissed)
        }
      try {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_PIP_MODE_CHANGED, params)
      } catch (error: Exception) {
        Log.w(TAG, "Failed to emit Picture-in-Picture mode change", error)
      }
    }

    /** Aspect ratio (width:height) used for the Picture-in-Picture window (portrait). */
    const val PIP_ASPECT_RATIO_WIDTH = 9
    const val PIP_ASPECT_RATIO_HEIGHT = 16

    /** Set while a call is active so the activity can enter PiP on user leave. */
    @Volatile
    var isCallActive: Boolean = false
  }
}
