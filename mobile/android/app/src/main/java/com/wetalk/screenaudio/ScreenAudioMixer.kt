package com.wetalk.screenaudio

import android.media.AudioFormat
import android.media.projection.MediaProjection
import android.util.Log
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Mixes captured system audio into the microphone buffer WebRTC is about to
 * encode.
 *
 * This is the whole trick. `getDisplayMedia` cannot return an audio track on
 * Android and libwebrtc has no "push this PCM into the uplink" API, but the
 * `io.github.webrtc-sdk` build exposes [JavaAudioDeviceModule.AudioBufferCallback],
 * which hands out the recording buffer after the microphone has been read and
 * before it is passed to native code. Adding system audio there means:
 *
 *  * no second track, no second sender, **no renegotiation** — an unmodified
 *    peer hears the shared audio immediately;
 *  * mute still works, because libwebrtc zeroes the microphone *before* this
 *    callback runs, so muting silences the mic and leaves the shared audio
 *    audible;
 *  * no forked libwebrtc and no shadowed framework classes.
 *
 * The callback runs on WebRTC's recording thread every 10 ms, so the mixing
 * loop stays allocation-free after warm-up and never blocks.
 */
internal class ScreenAudioMixer : JavaAudioDeviceModule.AudioBufferCallback {
  private val capture = SystemAudioCapture()

  @Volatile
  private var projection: MediaProjection? = null

  @Volatile
  private var startSignal: CountDownLatch? = null

  @Volatile
  private var mixedFrames = 0L

  /** Scratch space for one WebRTC buffer; sized on first use, then reused. */
  private var scratch = ByteArray(0)

  val state: ScreenAudioState
    get() = capture.state

  val lastError: String?
    get() = capture.lastError

  val diagnostics: Map<String, Any>
    get() =
      mapOf(
        "mixedFrames" to mixedFrames,
        "bytesCaptured" to capture.bytesCaptured,
        "bufferOverflows" to capture.overflows,
      )

  /**
   * Begin mixing [projection]'s playback into the uplink and wait until the
   * capture has had a chance to start.
   *
   * The wait matters: the capture format has to match whatever WebRTC is
   * recording at, and that is only known once [onBuffer] delivers a buffer.
   * Blocking here lets the JavaScript caller learn whether sharing actually
   * started instead of optimistically reporting success.
   *
   * @return the state reached, which is [ScreenAudioState.UNAVAILABLE] when no
   *   buffer arrived in time — typically because no call is recording.
   */
  fun start(
    projection: MediaProjection,
    timeoutMs: Long,
  ): ScreenAudioState {
    val signal = CountDownLatch(1)
    startSignal = signal
    this.projection = projection
    val settled = signal.await(timeoutMs, TimeUnit.MILLISECONDS)
    startSignal = null
    if (!settled) {
      Log.w(TAG, "No recording buffer arrived within ${timeoutMs}ms; is a call running?")
      this.projection = null
      return ScreenAudioState.UNAVAILABLE
    }
    return if (capture.isCapturing) capture.state else ScreenAudioState.UNAVAILABLE
  }

  fun stop() {
    projection = null
    startSignal?.countDown()
    startSignal = null
    capture.stop()
    mixedFrames = 0
  }

  override fun onBuffer(
    buffer: ByteBuffer,
    audioFormat: Int,
    channelCount: Int,
    sampleRate: Int,
    bytesRead: Int,
    captureTimeNs: Long,
  ): Long {
    val active = projection
    if (active == null) {
      if (capture.isCapturing) capture.stop()
      return captureTimeNs
    }
    // Everything else on the path assumes signed 16-bit PCM; bail out rather
    // than corrupt an unexpected encoding.
    if (audioFormat != AudioFormat.ENCODING_PCM_16BIT) return captureTimeNs
    if (!capture.isCapturing) {
      val started = capture.start(active, sampleRate, channelCount)
      startSignal?.countDown()
      if (!started) {
        projection = null
        return captureTimeNs
      }
    }
    mixInto(buffer)
    return captureTimeNs
  }

  private fun mixInto(buffer: ByteBuffer) {
    val frameBytes = buffer.capacity()
    if (scratch.size < frameBytes) scratch = ByteArray(frameBytes)
    val available = capture.buffer.read(scratch, frameBytes)
    if (available < PcmMixer.BYTES_PER_SAMPLE) return
    PcmMixer.mix(buffer, scratch, available)
    mixedFrames++
  }

  private companion object {
    const val TAG = "ScreenAudio"
  }
}
