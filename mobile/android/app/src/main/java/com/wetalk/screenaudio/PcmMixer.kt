package com.wetalk.screenaudio

import java.nio.ByteBuffer

/**
 * Sample arithmetic for combining two 16-bit PCM streams.
 *
 * Separated from [ScreenAudioMixer] because this is the part that is purely
 * numeric: no Android, no WebRTC, no threads. It runs inside WebRTC's 10 ms
 * recording callback, so it allocates nothing.
 */
internal object PcmMixer {
  const val BYTES_PER_SAMPLE = 2

  private const val MIN_SAMPLE = -32_768
  private const val MAX_SAMPLE = 32_767

  /**
   * Add [length] bytes of [source] into [destination], sample by sample.
   *
   * [destination] is the buffer WebRTC shares with native code, which reads it
   * from index 0 and ignores position and limit. Only absolute accessors are
   * used, so the buffer's own cursor is never disturbed — a relative `put`
   * here would leave the position at the end and make the next read
   * unpredictable.
   *
   * Sums are clamped rather than allowed to wrap: a wrapped sample flips from
   * full positive to full negative and is heard as a loud click.
   *
   * @return how many samples were mixed.
   */
  fun mix(
    destination: ByteBuffer,
    source: ByteArray,
    length: Int,
  ): Int {
    val usable = minOf(length, source.size, destination.capacity())
    var index = 0
    while (index + 1 < usable) {
      val existing = readSample(destination.get(index), destination.get(index + 1))
      val added = readSample(source[index], source[index + 1])
      val mixed = (existing + added).coerceIn(MIN_SAMPLE, MAX_SAMPLE)
      destination.put(index, (mixed and 0xFF).toByte())
      destination.put(index + 1, ((mixed shr 8) and 0xFF).toByte())
      index += BYTES_PER_SAMPLE
    }
    return index / BYTES_PER_SAMPLE
  }

  /**
   * Decode one signed 16-bit sample.
   *
   * Android PCM is little-endian, and [ByteBuffer.getShort] would honour the
   * buffer's byte order instead — which native code is free to have changed.
   */
  private fun readSample(
    low: Byte,
    high: Byte,
  ): Int = (high.toInt() shl 8) or (low.toInt() and 0xFF)
}
