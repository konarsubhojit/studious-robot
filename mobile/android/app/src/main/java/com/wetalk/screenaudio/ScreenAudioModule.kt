package com.wetalk.screenaudio

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * JavaScript bridge for sharing the device's audio alongside the screen.
 *
 * Starting capture waits for WebRTC to hand over a recording buffer, so the
 * work runs on a dedicated executor rather than blocking React Native's native
 * modules thread.
 */
class ScreenAudioModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ScreenAudioModule").apply { isDaemon = true }
  }

  override fun getName(): String = NAME

  override fun invalidate() {
    ScreenAudioDevice.stop()
    executor.shutdown()
    super.invalidate()
  }

  /**
   * Start mixing system audio into the call.
   *
   * Resolves with the resulting status rather than rejecting on failure: a
   * screen share that cannot carry audio still has to keep carrying video.
   */
  @ReactMethod
  fun start(promise: Promise) {
    executor.execute {
      val state = ScreenAudioDevice.start()
      promise.resolve(statusMap(state.isActive()))
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    executor.execute {
      ScreenAudioDevice.stop()
      promise.resolve(statusMap(false))
    }
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    promise.resolve(statusMap(null))
  }

  /**
   * Mute or unmute the microphone at the audio device module, leaving shared
   * system audio audible.
   */
  @ReactMethod
  fun setMicrophoneMuted(
    muted: Boolean,
    promise: Promise,
  ) {
    promise.resolve(ScreenAudioDevice.setMicrophoneMuted(muted))
  }

  private fun statusMap(sharing: Boolean?): WritableMap {
    val status = Arguments.createMap()
    val snapshot = ScreenAudioDevice.status()
    status.putBoolean("installed", snapshot["installed"] as? Boolean ?: false)
    status.putString("state", snapshot["state"] as? String ?: ScreenAudioState.UNAVAILABLE.name)
    status.putString("reason", snapshot["reason"] as? String)
    status.putDouble("mixedFrames", (snapshot["mixedFrames"] as? Long ?: 0L).toDouble())
    status.putDouble("bytesCaptured", (snapshot["bytesCaptured"] as? Long ?: 0L).toDouble())
    status.putDouble("bufferOverflows", (snapshot["bufferOverflows"] as? Long ?: 0L).toDouble())
    if (sharing != null) status.putBoolean("sharing", sharing)
    return status
  }

  private companion object {
    const val NAME = "ScreenAudio"

    fun ScreenAudioState.isActive() = this == ScreenAudioState.CAPTURING || this == ScreenAudioState.SILENT
  }
}
