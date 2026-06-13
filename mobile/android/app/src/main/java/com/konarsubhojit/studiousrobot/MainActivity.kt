package com.konarsubhojit.studiousrobot

import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "StudiousRobot"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Enter Picture-in-Picture automatically when the user leaves the app (e.g. presses Home)
   * while a call is active, so the call keeps playing in a small floating window.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && CallServiceModule.isCallActive) {
      val params =
        PictureInPictureParams.Builder()
          .setAspectRatio(Rational(9, 16))
          .build()
      enterPictureInPictureMode(params)
    }
  }
}
