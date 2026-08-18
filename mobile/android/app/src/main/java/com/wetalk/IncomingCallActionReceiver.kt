package com.wetalk

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/**
 * Handles the Accept / Decline action buttons on WeTalk's branded
 * incoming-call notification ([IncomingCallNotificationModule]).
 *
 * Acts directly on react-native-callkeep's Android `Connection` for the call
 * (via [CallConnections], WeTalk's own seam over
 * `io.wazo.callkeep.VoiceConnectionService.getConnection`) — the same object
 * `RNCallKeepModule.answerIncomingCall` / `rejectCall` call `onAnswer()` /
 * `onReject()` on from the JS bridge. Doing the same here needs no live
 * React/JS context, so the actions work as soon as the self-managed
 * ConnectionService is bound (which Telecom does to *route* the call, before
 * the JS bundle has necessarily finished loading), instead of depending on a
 * React Native bridge call that may not exist yet.
 *
 * `Connection.onAnswer()` / `onReject()` in turn make react-native-callkeep
 * re-emit the same `RNCallKeepPerformAnswerCallAction` /
 * `RNCallKeepPerformEndCallAction` native events that
 * `registerCallActionListeners` in `mobile/src/callKeep.js` already
 * subscribes to at module scope, so accepting/declining from this receiver
 * flows through the exact same JS call-flow plumbing the system dialer's own
 * Answer/Decline buttons would have used.
 *
 * Actually connecting media for an accepted call still requires the JS call
 * flow (`useCallFlow`) to mount and take over WebRTC negotiation; on a true
 * cold start that is the same "answer arrived before the JS context is
 * ready" race already handled by `pendingAnswerCallId` in `callKeep.js` (and
 * the separate cold-start-answer-path fix this feature builds on/depends on
 * — see the module doc comment in `callKeep.js`).
 */
class IncomingCallActionReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    val callId = intent.getStringExtra(EXTRA_CALL_ID)
    if (callId == null) {
      Log.w(TAG, "Action ${intent.action} ignored; no callId extra")
      return
    }
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(IncomingCallNotificationModule.notificationId(callId))

    when (intent.action) {
      IncomingCallNotificationModule.ACTION_ACCEPT -> {
        // The connection may already be gone (the call ended/timed out
        // elsewhere before the user tapped an action); there is nothing
        // left to accept in that case. Log it so "the answer never reached
        // the call flow" is distinguishable from "the app never came up".
        if (!CallConnections.answer(callId)) {
          Log.w(TAG, "Accept ignored for callId=$callId; no live CallKeep connection")
          return
        }
        Log.i(TAG, "Answered callId=$callId; bringing app to the foreground")
        // Bring the app to the foreground so the user sees the in-call
        // screen once `useCallFlow` picks up the resulting answerCall event.
        val activityIntent =
          Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("wetalk://call/$callId")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(MainActivity.EXTRA_INCOMING_CALL, true)
          }
        try {
          context.startActivity(activityIntent)
        } catch (error: Exception) {
          Log.e(TAG, "Failed to launch MainActivity for callId=$callId", error)
        }
      }
      IncomingCallNotificationModule.ACTION_DECLINE -> {
        val rejected = CallConnections.reject(callId)
        Log.i(TAG, "Decline for callId=$callId rejected=$rejected")
      }
    }
  }

  companion object {
    private const val TAG = "WeTalkCallAction"

    const val EXTRA_CALL_ID = "com.wetalk.EXTRA_CALL_ID"
  }
}
