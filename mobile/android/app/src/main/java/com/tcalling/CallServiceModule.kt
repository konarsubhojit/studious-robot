package com.tcalling

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Intent
import android.os.Build
import android.util.Rational
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native bridge that lets JavaScript start/stop the call foreground service and
 * request Picture-in-Picture mode for the current activity.
 */
class CallServiceModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

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
  }

  @ReactMethod
  fun stopService() {
    isCallActive = false
    val intent = Intent(reactContext, CallForegroundService::class.java)
    reactContext.stopService(intent)
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
        PictureInPictureParams.Builder()
          .setAspectRatio(Rational(PIP_ASPECT_RATIO_WIDTH, PIP_ASPECT_RATIO_HEIGHT))
          .build()
      val entered = activity.enterPictureInPictureMode(params)
      promise.resolve(entered)
    } catch (error: Exception) {
      promise.reject("PIP_ERROR", error)
    }
  }

  companion object {
    const val NAME = "CallService"

    /** Aspect ratio (width:height) used for the Picture-in-Picture window (portrait). */
    const val PIP_ASPECT_RATIO_WIDTH = 9
    const val PIP_ASPECT_RATIO_HEIGHT = 16

    /** Set while a call is active so the activity can enter PiP on user leave. */
    @Volatile
    var isCallActive: Boolean = false
  }
}
