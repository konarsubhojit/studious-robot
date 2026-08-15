package com.wetalk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native module behind WeTalk's own branded incoming-call notification.
 *
 * `mobile/src/callKeep.js` runs Android's `react-native-callkeep` with a
 * *self-managed* phone account (`selfManaged: true`): Telecom hands the
 * entire ringing UI to the app instead of drawing the generic system-dialer
 * UI itself, and fires a `showIncomingCallUi` event to ask for it (see
 * `registerShowIncomingCallUiListener` in `callKeep.js`). This module is what
 * answers that event from the JS side (`incomingCallNotification.js`): it
 * posts a full-screen-intent notification, with the caller's identity and
 * Accept / Decline actions, over a high-importance channel with sound and
 * vibration so the device actually rings.
 */
class IncomingCallNotificationModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun show(callId: String, callerName: String, hasVideo: Boolean, promise: Promise) {
    try {
      val manager = notificationManager()
      createNotificationChannel(manager)
      manager.notify(notificationId(callId), buildNotification(callId, callerName, hasVideo, manager))
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("INCOMING_CALL_NOTIFICATION_SHOW_FAILED", error)
    }
  }

  @ReactMethod
  fun dismiss(callId: String) {
    notificationManager().cancel(notificationId(callId))
  }

  private fun notificationManager(): NotificationManager =
    reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun createNotificationChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel =
      NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
    channel.description = "WeTalk's own full-screen incoming-call ringing screen"
    channel.enableVibration(true)
    channel.vibrationPattern = VIBRATION_PATTERN
    channel.enableLights(true)
    // Calls should still ring through Do Not Disturb, matching the system
    // dialer; full effect additionally depends on the user having granted
    // Do Not Disturb access, same as any other calling app.
    channel.setBypassDnd(true)
    val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
    val audioAttributes =
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
    channel.setSound(ringtoneUri, audioAttributes)
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(
    callId: String,
    callerName: String,
    hasVideo: Boolean,
    manager: NotificationManager,
  ): Notification {
    val builder =
      NotificationCompat.Builder(reactContext, CHANNEL_ID)
        .setContentTitle(callerName)
        .setContentText(if (hasVideo) "Incoming WeTalk video call" else "Incoming WeTalk call")
        .setSmallIcon(android.R.drawable.ic_menu_call)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setOngoing(true)
        .setAutoCancel(false)
        .setContentIntent(fullScreenPendingIntent(callId))
        .addAction(0, "Decline", actionPendingIntent(callId, ACTION_DECLINE))
        .addAction(0, "Accept", actionPendingIntent(callId, ACTION_ACCEPT))

    // Android 14+ restricts full-screen intents to apps the user has granted
    // special "Alarms & reminders"-style access to; a non-exempt app that
    // still calls setFullScreenIntent has it silently downgraded to a normal
    // heads-up notification by the platform. Checking explicitly here just
    // lets this module log the degraded case; either way the channel's sound
    // and vibration (created above) still ring the device, so incoming calls
    // are never silent even when the full-screen UI can't be drawn.
    val canUseFullScreenIntent =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || manager.canUseFullScreenIntent()
    if (canUseFullScreenIntent) {
      builder.setFullScreenIntent(fullScreenPendingIntent(callId), true)
    }

    return builder.build()
  }

  /** Launches [MainActivity] over the lock screen, showing the branded incoming-call screen. */
  private fun fullScreenPendingIntent(callId: String): PendingIntent {
    val intent =
      Intent(reactContext, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse("wetalk://call/$callId")
        flags = Intent.FLAG_ACTIVITY_NEW_TASK
        putExtra(MainActivity.EXTRA_INCOMING_CALL, true)
      }
    return PendingIntent.getActivity(
      reactContext,
      notificationId(callId),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** Routes a notification action button through [IncomingCallActionReceiver]. */
  private fun actionPendingIntent(callId: String, action: String): PendingIntent {
    val intent =
      Intent(reactContext, IncomingCallActionReceiver::class.java).apply {
        this.action = action
        putExtra(IncomingCallActionReceiver.EXTRA_CALL_ID, callId)
      }
    return PendingIntent.getBroadcast(
      reactContext,
      (callId + action).hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  companion object {
    const val NAME = "IncomingCallNotification"
    const val CHANNEL_ID = "wetalk_incoming_calls"
    const val ACTION_ACCEPT = "com.wetalk.action.ACCEPT_CALL"
    const val ACTION_DECLINE = "com.wetalk.action.DECLINE_CALL"
    private val VIBRATION_PATTERN = longArrayOf(0, 1000, 1000)

    /** Stable, app-unique notification id derived from the call id. */
    fun notificationId(callId: String): Int = callId.hashCode()
  }
}
