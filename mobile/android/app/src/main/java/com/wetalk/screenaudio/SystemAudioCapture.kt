package com.wetalk.screenaudio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Process
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * Captures what the device is playing and hands it to [ScreenAudioMixer].
 *
 * Uses Android's playback capture API, which needs a [MediaProjection] — the
 * same consent the screen share already obtained. It deliberately **borrows**
 * that projection rather than requesting its own: Android allows one active
 * projection at a time, so a second consent prompt would stop the screen share
 * it was meant to accompany.
 *
 * `USAGE_VOICE_COMMUNICATION` is not matched. That is the call's own playout;
 * capturing it would feed the remote party's voice straight back to them.
 */
internal class SystemAudioCapture {
  private val lock = Any()
  private var record: AudioRecord? = null
  private var thread: Thread? = null

  @Volatile
  private var keepAlive = false

  @Volatile
  private var heardAudio = false

  @Volatile
  private var capturedBytes = 0L

  /** Format the capture is currently running at, so a change can restart it. */
  private var sampleRate = 0
  private var channelCount = 0

  val buffer = PcmRingBuffer(RING_BUFFER_BYTES)

  /** Why the last [start] failed, for the JS-side diagnostics. */
  @Volatile
  var lastError: String? = null
    private set

  val isCapturing: Boolean
    get() = keepAlive

  val state: ScreenAudioState
    get() =
      when {
        !isPlatformSupported() -> ScreenAudioState.UNSUPPORTED_PLATFORM
        !keepAlive -> ScreenAudioState.IDLE
        heardAudio -> ScreenAudioState.CAPTURING
        else -> ScreenAudioState.SILENT
      }

  val bytesCaptured: Long
    get() = capturedBytes

  val overflows: Long
    get() = buffer.overflows

  /**
   * Start capturing [projection]'s playback at the format WebRTC is recording
   * at, so no resampling is needed on the way into the uplink.
   *
   * @return true when capture is running.
   */
  fun start(
    projection: MediaProjection,
    sampleRate: Int,
    channelCount: Int,
  ): Boolean {
    if (!isPlatformSupported()) {
      lastError = "Playback capture needs Android 10 or newer"
      return false
    }
    synchronized(lock) {
      if (keepAlive && sampleRate == this.sampleRate && channelCount == this.channelCount) {
        return true
      }
      stopLocked()
      return startLocked(projection, sampleRate, channelCount)
    }
  }

  fun stop() {
    synchronized(lock) { stopLocked() }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun buildRecord(
    projection: MediaProjection,
    sampleRate: Int,
    channelCount: Int,
    bufferSizeInBytes: Int,
  ): AudioRecord {
    val config =
      AudioPlaybackCaptureConfiguration
        .Builder(projection)
        .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
        .addMatchingUsage(AudioAttributes.USAGE_GAME)
        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
        .build()
    val format =
      AudioFormat
        .Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(sampleRate)
        .setChannelMask(channelMask(channelCount))
        .build()
    return AudioRecord
      .Builder()
      .setAudioFormat(format)
      .setBufferSizeInBytes(bufferSizeInBytes)
      .setAudioPlaybackCaptureConfig(config)
      .build()
  }

  // Guarded by `lock`; the platform check lives in `start`.
  @SuppressLint("NewApi")
  private fun startLocked(
    projection: MediaProjection,
    sampleRate: Int,
    channelCount: Int,
  ): Boolean {
    val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelMask(channelCount), AudioFormat.ENCODING_PCM_16BIT)
    if (minBufferSize <= 0) {
      lastError = "Device rejected ${sampleRate}Hz x $channelCount capture"
      return false
    }
    val bufferSizeInBytes = maxOf(minBufferSize * BUFFER_SIZE_FACTOR, RING_BUFFER_BYTES / 2)
    val created =
      try {
        buildRecord(projection, sampleRate, channelCount, bufferSizeInBytes)
      } catch (error: Exception) {
        // A revoked/invalid projection, a denied RECORD_AUDIO grant and an
        // unsupported format all surface here, and none of them may crash a
        // live call.
        lastError = error.message ?: error.javaClass.simpleName
        Log.w(TAG, "Unable to build the playback capture record", error)
        return false
      }
    if (created.state != AudioRecord.STATE_INITIALIZED) {
      created.release()
      lastError = "Playback capture could not be initialised"
      return false
    }
    try {
      created.startRecording()
    } catch (error: IllegalStateException) {
      created.release()
      lastError = error.message ?: "Playback capture refused to start"
      Log.w(TAG, "Unable to start the playback capture record", error)
      return false
    }

    record = created
    this.sampleRate = sampleRate
    this.channelCount = channelCount
    buffer.clear()
    heardAudio = false
    capturedBytes = 0
    lastError = null
    keepAlive = true
    thread =
      Thread({ readLoop(created, bufferSizeInBytes) }, "ScreenAudioCapture").apply {
        isDaemon = true
        start()
      }
    Log.i(TAG, "System audio capture started at ${sampleRate}Hz x $channelCount")
    return true
  }

  // Guarded by `lock`.
  private fun stopLocked() {
    keepAlive = false
    thread?.join(THREAD_JOIN_TIMEOUT_MS)
    thread = null
    record?.let { active ->
      try {
        active.stop()
      } catch (error: IllegalStateException) {
        Log.w(TAG, "Playback capture was already stopped", error)
      }
      active.release()
    }
    record = null
    sampleRate = 0
    channelCount = 0
    buffer.clear()
  }

  private fun readLoop(
    active: AudioRecord,
    bufferSizeInBytes: Int,
  ) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val chunk = ByteArray(minOf(bufferSizeInBytes, RING_BUFFER_BYTES / 2))
    while (keepAlive) {
      val read =
        try {
          active.read(chunk, 0, chunk.size)
        } catch (error: IllegalStateException) {
          Log.w(TAG, "Playback capture read failed", error)
          break
        }
      if (read <= 0) {
        // ERROR_INVALID_OPERATION is what a revoked projection looks like.
        if (read < 0) {
          lastError = "Playback capture ended (code $read)"
          Log.w(TAG, "Playback capture ended with code $read")
          break
        }
        continue
      }
      capturedBytes += read
      if (!heardAudio && containsAudio(chunk, read)) heardAudio = true
      buffer.write(chunk, read)
    }
    keepAlive = false
  }

  private companion object {
    const val TAG = "ScreenAudio"

    /**
     * ~200 ms at 48 kHz stereo. Large enough to absorb a scheduling hiccup,
     * small enough that a listener never hears the screen and its sound drift
     * apart.
     */
    const val RING_BUFFER_BYTES = 48_000 * 2 * 2 / 5

    const val BUFFER_SIZE_FACTOR = 2
    const val THREAD_JOIN_TIMEOUT_MS = 2_000L

    fun isPlatformSupported() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    fun channelMask(channelCount: Int) =
      if (channelCount >= 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO

    /** Whether any sample in the first [length] bytes is not digital silence. */
    fun containsAudio(
      chunk: ByteArray,
      length: Int,
    ): Boolean {
      for (index in 0 until length) {
        if (chunk[index] != ZERO_BYTE) return true
      }
      return false
    }

    const val ZERO_BYTE: Byte = 0
  }
}
