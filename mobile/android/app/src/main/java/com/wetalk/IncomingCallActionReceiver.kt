package com.wetalk

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/**
 * Handles the Decline action button on WeTalk's branded incoming-call
 * notification ([IncomingCallNotificationModule]), and remains a compatible
 * receiver for Accept intents posted by an earlier build's notification.
 *
 * Acts on react-native-callkeep's Android `Connection` for the call (via
 * [CallConnections], WeTalk's own seam over
 * `io.wazo.callkeep.VoiceConnectionService.getConnection`) when one exists —
 * the same object `RNCallKeepModule.answerIncomingCall` / `rejectCall` call
 * `onAnswer()` / `onReject()` on from the JS bridge — so the OS call UI stays
 * in sync without needing a live React/JS context.
 *
 * Crucially, that connection is treated as an *optimisation, not a
 * prerequisite*. On a cold start Telecom frequently never completes a
 * connection (`setupCallKeep` runs with no foreground Activity), yet the
 * branded notification is still posted, so gating on `CallConnections.answer()`
 * / `reject()` — as this receiver used to — made the buttons silent no-ops
 * exactly when they were needed most. Every action is therefore *also*
 * persisted via [PendingCallStore], which survives process death, so
 * `useCallFlow` can drain it on mount and complete the accept/decline against
 * the server over the socket or the HTTP fallback.
 *
 * Accept is now delivered by an Activity `PendingIntent` straight to
 * [MainActivity] (Android 12+ blocks notification trampolines, and Android 10+
 * restricts background activity starts from a receiver), so it no longer
 * depends on this receiver being able to launch an Activity.
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
        // Legacy path: only reachable from a notification posted by an older
        // build. The connection may already be gone, which must not stop the
        // app from opening and completing the accept in JS.
        val connectionLive = CallConnections.answer(callId)
        Log.i(TAG, "Accept received callId=$callId connectionLive=$connectionLive")
        PendingCallStore.recordAction(
          context,
          callId,
          PendingCallStore.ACTION_ACCEPT,
          connectionLive,
        )
        val activityIntent =
          Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("wetalk://call/$callId")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(MainActivity.EXTRA_INCOMING_CALL, true)
          }
        try {
          context.startActivity(activityIntent)
          Log.i(TAG, "Launched MainActivity for callId=$callId")
        } catch (error: Exception) {
          // Background activity-start restrictions (Android 10+) and OEM
          // policies can block this; the persisted accept above still lets the
          // call be answered the next time the app runs.
          Log.e(TAG, "Failed to launch MainActivity for callId=$callId", error)
        }
      }
      IncomingCallNotificationModule.ACTION_DECLINE -> {
        val connectionLive = CallConnections.reject(callId)
        Log.i(TAG, "Decline received callId=$callId connectionLive=$connectionLive")
        // Rejecting the Telecom connection only tears down the local OS call
        // UI; the server is told by the JS call flow when it drains this.
        PendingCallStore.recordAction(
          context,
          callId,
          PendingCallStore.ACTION_DECLINE,
          connectionLive,
        )
        PendingCallStore.clearRinging(context, callId)
      }
      else -> Log.w(TAG, "Unknown action ${intent.action} for callId=$callId")
    }
  }

  companion object {
    private const val TAG = "WeTalkCallAction"

    const val EXTRA_CALL_ID = "com.wetalk.EXTRA_CALL_ID"
  }
}
