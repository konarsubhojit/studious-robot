package com.wetalk.screenaudio

import android.content.Context
import android.os.Build
import android.util.Log
import com.oney.WebRTCModule.LibraryLoader
import com.oney.WebRTCModule.ScreenCaptureController
import com.oney.WebRTCModule.WebRTCModuleOptions
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Owns the custom audio device module that makes system-audio sharing possible.
 *
 * `react-native-webrtc` builds its `PeerConnectionFactory` from
 * `WebRTCModuleOptions.audioDeviceModule` when one is supplied, so installing a
 * [JavaAudioDeviceModule] carrying a [ScreenAudioMixer] before the React
 * Native bridge starts is enough to own the microphone buffer for the whole
 * process. Nothing else about the WebRTC integration changes.
 *
 * Install once, from `Application.onCreate`. Every failure is absorbed: if the
 * module cannot be built the app falls back to the stock audio device module
 * and system-audio sharing simply reports itself unavailable.
 */
object ScreenAudioDevice {
  private const val TAG = "ScreenAudio"

  /**
   * How long to wait for WebRTC to hand over a recording buffer when starting.
   * Two seconds comfortably covers the 10 ms recording cadence while still
   * failing fast when nothing is recording at all.
   */
  private const val START_TIMEOUT_MS = 2_000L

  private val mixer = ScreenAudioMixer()

  @Volatile
  private var audioDeviceModule: JavaAudioDeviceModule? = null

  @Volatile
  private var unavailableReason: String? = null

  /** Whether the mixing seam is in place for this process. */
  val isInstalled: Boolean
    get() = audioDeviceModule != null

  /**
   * Install the mixing audio device module.
   *
   * Must run before `WebRTCModule` is constructed — i.e. from
   * `Application.onCreate` — because the factory reads the option exactly once.
   */
  fun install(context: Context) {
    if (audioDeviceModule != null) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      unavailableReason = "System audio sharing needs Android 10 or newer"
      return
    }
    try {
      // `createAudioDeviceModule` reaches into native code, so the library has
      // to be loaded first. `WebRTCModule` runs the same initialisation later
      // with the same loader; repeating it is a no-op.
      PeerConnectionFactory.initialize(
        PeerConnectionFactory
          .InitializationOptions
          .builder(context.applicationContext)
          .setNativeLibraryLoader(LibraryLoader())
          .createInitializationOptions(),
      )
      val module =
        JavaAudioDeviceModule
          .builder(context.applicationContext)
          .setEnableVolumeLogger(false)
          .setAudioBufferCallback(mixer)
          .createAudioDeviceModule()
      WebRTCModuleOptions.getInstance().audioDeviceModule = module
      audioDeviceModule = module
      unavailableReason = null
      Log.i(TAG, "Installed the system-audio mixing audio device module")
    } catch (error: UnsatisfiedLinkError) {
      // A stripped ABI or a WebRTC build without the mixing seam. Falling back
      // to the stock module keeps calls working without system audio.
      unavailableReason = "WebRTC native library unavailable: ${error.message}"
      Log.e(TAG, "Unable to install the audio device module", error)
    } catch (error: Exception) {
      unavailableReason = error.message ?: error.javaClass.simpleName
      Log.e(TAG, "Unable to install the audio device module", error)
    }
  }

  /**
   * Start mixing the device's playback into the uplink, borrowing the screen
   * share's projection.
   *
   * @return the state reached; never throws, so a failure downgrades the screen
   *   share to video-only instead of ending it.
   */
  fun start(): ScreenAudioState {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return ScreenAudioState.UNSUPPORTED_PLATFORM
    if (audioDeviceModule == null) return ScreenAudioState.UNAVAILABLE
    val projection = ScreenCaptureController.getActiveMediaProjection()
    if (projection == null) {
      unavailableReason = "No screen share is running"
      return ScreenAudioState.UNAVAILABLE
    }
    // Playback capture is music and speech, not a voice call: the capture-side
    // noise suppressor treats it as noise and mangles it.
    audioDeviceModule?.setNoiseSuppressorEnabled(false)
    val state = mixer.start(projection, START_TIMEOUT_MS)
    if (state == ScreenAudioState.UNAVAILABLE && unavailableReason == null) {
      unavailableReason = mixer.lastError ?: "System audio capture did not start"
    }
    return state
  }

  fun stop() {
    mixer.stop()
    audioDeviceModule?.setNoiseSuppressorEnabled(true)
  }

  /**
   * Mute the microphone without silencing shared system audio.
   *
   * Disabling the local audio track would mute both, because both travel on the
   * same track. libwebrtc zeroes the microphone buffer *before*
   * [ScreenAudioMixer] adds system audio, so muting here leaves the shared
   * audio audible.
   *
   * @return whether the mute was applied natively; false means the caller must
   *   fall back to toggling the track.
   */
  fun setMicrophoneMuted(muted: Boolean): Boolean {
    val module = audioDeviceModule ?: return false
    module.setMicrophoneMute(muted)
    return true
  }

  /** Current state plus the counters that make a silent share diagnosable. */
  fun status(): Map<String, Any?> =
    mapOf(
      "installed" to isInstalled,
      "state" to mixer.state.name,
      "reason" to (mixer.lastError ?: unavailableReason),
    ) + mixer.diagnostics
}
