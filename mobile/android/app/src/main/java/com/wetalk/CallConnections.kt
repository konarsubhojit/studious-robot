package com.wetalk

import io.wazo.callkeep.VoiceConnectionService

/**
 * WeTalk-owned seam over react-native-callkeep's native `Connection` state
 * for a self-managed call.
 *
 * [MainActivity] and [IncomingCallActionReceiver] both need to know whether
 * a call id still has a live native CallKeep connection, and the latter also
 * needs to answer/reject one directly (see its doc comment for why this
 * bypasses the JS bridge). Routing both through this object instead of each
 * reaching into `io.wazo.callkeep.VoiceConnectionService` directly keeps the
 * third-party dependency confined to one file, so a future change to how
 * react-native-callkeep exposes connections only has to be made here.
 */
object CallConnections {
  /** Whether [callId] still has a live, native CallKeep connection. */
  fun isLive(callId: String): Boolean = VoiceConnectionService.getConnection(callId) != null

  /** Answers [callId]'s connection if it's still live. Returns `true` if answered. */
  fun answer(callId: String): Boolean {
    val connection = VoiceConnectionService.getConnection(callId) ?: return false
    connection.onAnswer()
    return true
  }

  /** Rejects [callId]'s connection if it's still live. Returns `true` if rejected. */
  fun reject(callId: String): Boolean {
    val connection = VoiceConnectionService.getConnection(callId) ?: return false
    connection.onReject()
    return true
  }
}
