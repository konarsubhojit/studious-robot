package com.wetalk

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.oney.WebRTCModule.WebRTCModuleOptions

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(CallServicePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Screen sharing (`getDisplayMedia`) captures through Android's
    // MediaProjection API, which from Android 10 (and strictly from Android 14)
    // only produces frames while a foreground service of type `mediaProjection`
    // is running. react-native-webrtc ships that service but keeps it disabled
    // by default, and without it the remote peer receives a black video track.
    // Must be set before the WebRTC native module is initialised.
    WebRTCModuleOptions.getInstance().enableMediaProjectionService = true
    loadReactNative(this)
  }
}
