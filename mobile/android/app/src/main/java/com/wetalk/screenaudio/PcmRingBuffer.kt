package com.wetalk.screenaudio

/**
 * Bounded FIFO of 16-bit PCM bytes between the playback-capture reader thread
 * and WebRTC's recording thread.
 *
 * The two threads run on different clocks: the capture [android.media.AudioRecord]
 * delivers whatever the system mixer produces, while WebRTC asks for exactly
 * one 10 ms buffer every 10 ms. A queue that grew to absorb the difference
 * would turn a transient stall into permanent latency, so this one is fixed
 * size and **drops the oldest audio** when it overflows: a listener hears a
 * short glitch rather than a soundtrack that drifts further behind the screen
 * with every hiccup.
 *
 * @param capacityBytes size of the backing store; also the maximum latency the
 *   buffer can hold.
 */
internal class PcmRingBuffer(
  capacityBytes: Int,
) {
  private val buffer = ByteArray(capacityBytes)
  private var readIndex = 0
  private var available = 0

  /** Bytes currently buffered. */
  val size: Int
    @Synchronized get() = available

  /** How often the buffer dropped audio because WebRTC fell behind. */
  @get:Synchronized
  var overflows: Long = 0
    private set

  /**
   * Append up to [length] bytes of [source], discarding the oldest audio when
   * the buffer is full.
   */
  @Synchronized
  fun write(
    source: ByteArray,
    length: Int,
  ) {
    if (length <= 0) return
    // A write larger than the whole buffer can only keep its tail.
    val offset = if (length > buffer.size) length - buffer.size else 0
    val count = length - offset
    var writeIndex = (readIndex + available) % buffer.size
    for (index in 0 until count) {
      buffer[writeIndex] = source[offset + index]
      writeIndex = (writeIndex + 1) % buffer.size
    }
    val free = buffer.size - available
    if (count > free) {
      overflows++
      readIndex = writeIndex
      available = buffer.size
    } else {
      available += count
    }
  }

  /**
   * Copy at most [length] bytes into [destination].
   *
   * @return how many bytes were copied, which is less than [length] when the
   *   capture has not produced enough audio yet.
   */
  @Synchronized
  fun read(
    destination: ByteArray,
    length: Int,
  ): Int {
    val count = minOf(length, available, destination.size)
    for (index in 0 until count) {
      destination[index] = buffer[readIndex]
      readIndex = (readIndex + 1) % buffer.size
    }
    available -= count
    return count
  }

  /** Forget everything buffered, e.g. when capture restarts. */
  @Synchronized
  fun clear() {
    readIndex = 0
    available = 0
  }
}
