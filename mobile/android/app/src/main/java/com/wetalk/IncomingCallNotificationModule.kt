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
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

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
class IncomingCallNotificationModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  /**
   * Post the branded incoming-call notification.
   *
   * Resolves with what the *device* will actually do, not just that a
   * notification was posted: the channel's real importance and sound are read
   * back after creation, because channel settings are immutable once created
   * and an older, quieter channel from a previous install would otherwise
   * silently swallow the ring (see [createNotificationChannel]). The JS side
   * uses this to start its own ringtone fallback instead of assuming the
   * channel rings.
   */
  @ReactMethod
  fun show(
    callId: String,
    callerName: String,
    hasVideo: Boolean,
    promise: Promise,
  ) {
    try {
      val manager = notificationManager()
      createNotificationChannel(manager)
      // Remember that this app is ringing for the call, so the Accept path and
      // the lock-screen wake can trust the call id even when Telecom never
      // created a CallKeep connection (the cold-start case).
      PendingCallStore.markRinging(reactContext, callId)
      manager.notify(notificationId(callId), buildNotification(callId, callerName, hasVideo, manager))

      val result = channelAudioState(manager)
      result.putBoolean("shown", true)
      result.putBoolean("connectionLive", CallConnections.isLive(callId))
      Log.i(
        TAG,
        "Posted incoming-call notification callId=$callId" +
          " importance=${result.getInt("channelImportance")}" +
          " hasSound=${result.getBoolean("channelHasSound")}" +
          " connectionLive=${result.getBoolean("connectionLive")}",
      )
      promise.resolve(result)
    } catch (error: Exception) {
      Log.e(TAG, "Failed to post incoming-call notification callId=$callId", error)
      promise.reject("INCOMING_CALL_NOTIFICATION_SHOW_FAILED", error)
    }
  }

  @ReactMethod
  fun dismiss(callId: String) {
    notificationManager().cancel(notificationId(callId))
    PendingCallStore.clearRinging(reactContext, callId)
    // The call is over (answered/declined/ended) by the time dismiss() is
    // called, so its id can be freed instead of growing notificationIds
    // for the lifetime of the process.
    notificationIds.remove(callId)
  }

  /**
   * Remove and return the Accept / Decline the user tapped while the JS
   * context was not running, so the call flow can replay it on mount.
   * Resolves `null` when there is nothing pending.
   */
  @ReactMethod
  fun consumePendingCallAction(promise: Promise) {
    try {
      val pending = PendingCallStore.consumeAction(reactContext)
      if (pending == null) {
        promise.resolve(null)
        return
      }
      val payload = Arguments.createMap()
      payload.putString("callId", pending.callId)
      payload.putString("action", pending.action)
      payload.putDouble("ageMs", pending.ageMs.toDouble())
      payload.putBoolean("connectionLive", pending.connectionLive)
      promise.resolve(payload)
    } catch (error: Exception) {
      Log.e(TAG, "consumePendingCallAction failed", error)
      promise.reject("PENDING_CALL_ACTION_FAILED", error)
    }
  }

  /** Whether Telecom still holds a live CallKeep connection for [callId]. */
  @ReactMethod
  fun isCallConnectionLive(
    callId: String,
    promise: Promise,
  ) {
    promise.resolve(CallConnections.isLive(callId))
  }

  /** The channel's *effective* importance and sound, post-creation. */
  private fun channelAudioState(manager: NotificationManager): WritableMap {
    val state = Arguments.createMap()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // Pre-O has no channels: importance/sound come from the notification
      // itself, which is built with PRIORITY_HIGH and the default ringtone.
      state.putInt("channelImportance", NotificationManager.IMPORTANCE_HIGH)
      state.putBoolean("channelHasSound", true)
      return state
    }
    val channel = manager.getNotificationChannel(CHANNEL_ID)
    state.putInt("channelImportance", channel?.importance ?: NotificationManager.IMPORTANCE_NONE)
    state.putBoolean("channelHasSound", channel?.sound != null)
    return state
  }

  private fun notificationManager(): NotificationManager =
    reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /**
   * Create the incoming-call channel, deleting superseded versions first.
   *
   * Notification channel settings are immutable once the channel exists, so an
   * install that ever created an earlier, quieter version of this channel would
   * ignore the importance/sound/vibration configured below *forever* — the
   * classic "notification appears but is silent" bug, which a reinstall fixes
   * and an app upgrade does not. Versioning the channel id (and deleting the
   * obsolete ids on upgrade) is what makes these settings apply on existing
   * installs.
   */
  private fun createNotificationChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    for (obsoleteId in OBSOLETE_CHANNEL_IDS) {
      if (manager.getNotificationChannel(obsoleteId) != null) {
        Log.i(TAG, "Deleting obsolete notification channel $obsoleteId")
        manager.deleteNotificationChannel(obsoleteId)
      }
    }

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
      AudioAttributes
        .Builder()
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
      NotificationCompat
        .Builder(reactContext, CHANNEL_ID)
        .setContentTitle(callerName)
        .setContentText(if (hasVideo) "Incoming WeTalk video call" else "Incoming WeTalk call")
        .setSmallIcon(android.R.drawable.ic_menu_call)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setOngoing(true)
        .setAutoCancel(false)
        .setContentIntent(fullScreenPendingIntent(callId))
        .addAction(0, "Decline", actionPendingIntent(callId, ACTION_DECLINE))
        // Accept targets an Activity directly rather than a BroadcastReceiver
        // that starts one: Android 12+ blocks notification "trampolines", and
        // Android 10+ restricts background activity starts, which is why the
        // Accept button opened the app on some devices and did nothing on
        // others. An Activity PendingIntent is always allowed to launch.
        .addAction(0, "Accept", acceptPendingIntent(callId))

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

  /**
   * Launches [MainActivity] for an Accept tap. The accept is completed by the
   * JS call flow (socket `call.accept`, or the HTTP fallback), so it works
   * whether or not Telecom ever created a CallKeep connection.
   */
  private fun acceptPendingIntent(callId: String): PendingIntent {
    val intent =
      Intent(reactContext, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse("wetalk://call/$callId")
        flags = Intent.FLAG_ACTIVITY_NEW_TASK
        putExtra(MainActivity.EXTRA_INCOMING_CALL, true)
        putExtra(MainActivity.EXTRA_ACCEPT_CALL, true)
      }
    return PendingIntent.getActivity(
      reactContext,
      actionRequestCode(callId, ACTION_ACCEPT),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** Routes a notification action button through [IncomingCallActionReceiver]. */
  private fun actionPendingIntent(
    callId: String,
    action: String,
  ): PendingIntent {
    val intent =
      Intent(reactContext, IncomingCallActionReceiver::class.java).apply {
        this.action = action
        putExtra(IncomingCallActionReceiver.EXTRA_CALL_ID, callId)
      }
    return PendingIntent.getBroadcast(
      reactContext,
      actionRequestCode(callId, action),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  companion object {
    const val NAME = "IncomingCallNotification"

    /**
     * Versioned channel id — bump this (and add the previous value to
     * [OBSOLETE_CHANNEL_IDS]) whenever the channel's sound, importance or
     * vibration settings change, since Android ignores changes to an existing
     * channel.
     */
    const val CHANNEL_ID = "wetalk_incoming_calls.v2"

    /** Superseded channel ids, deleted on first use of the current channel. */
    private val OBSOLETE_CHANNEL_IDS = listOf("wetalk_incoming_calls")

    private const val TAG = "WeTalkCallNotification"
    const val ACTION_ACCEPT = "com.wetalk.action.ACCEPT_CALL"
    const val ACTION_DECLINE = "com.wetalk.action.DECLINE_CALL"
    private val VIBRATION_PATTERN = longArrayOf(0, 1000, 1000)

    /**
     * Multiplier used to derive an action button's `PendingIntent` request
     * code from its call's [notificationId], leaving room below it for the
     * (at most two) action-specific offsets added in [actionRequestCode].
     */
    private const val ACTION_REQUEST_CODE_MULTIPLIER = 4

    private val notificationIds = ConcurrentHashMap<String, Int>()
    private val nextNotificationId = AtomicInteger(1)

    /**
     * Stable, collision-free notification id for a call, used both as the
     * Android notification id and as the content `PendingIntent`'s request
     * code. Each call id is assigned the next small integer the first time
     * it's seen, instead of hashing it — `String.hashCode()` is only a
     * 32-bit value, so two different call ids could theoretically collide.
     */
    fun notificationId(callId: String): Int =
      notificationIds.computeIfAbsent(callId) { nextNotificationId.getAndIncrement() }

    /** Collision-free request code for an action button's `PendingIntent`. */
    private fun actionRequestCode(
      callId: String,
      action: String,
    ): Int {
      val actionOffset = if (action == ACTION_ACCEPT) 1 else 2
      return notificationId(callId) * ACTION_REQUEST_CODE_MULTIPLIER + actionOffset
    }
  }
}
