package com.wetalk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native module behind WeTalk's chat-message notification.
 *
 * Message pushes are sent data-only (`buildDataBlock` in `server/src/push.js`),
 * so FCM displays nothing by itself and the app has to render the notification
 * — this is that renderer, the chat counterpart of
 * [IncomingCallNotificationModule].
 *
 * It deliberately does *not* reuse the incoming-call channel: that channel is
 * `IMPORTANCE_HIGH` with a ringtone, an ongoing (non-dismissible) notification
 * and a full-screen intent, all of which are wrong for a chat message. Messages
 * get their own `IMPORTANCE_DEFAULT` channel with the default notification
 * sound, `CATEGORY_MESSAGE`, and a `MessagingStyle` body so several messages in
 * the same conversation stack into a single shade entry (keyed by the
 * conversation id) instead of spamming one entry per message.
 */
class MessageNotificationModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  /**
   * Post (or extend) the notification for one conversation.
   *
   * Resolves with the channel's *effective* importance and sound so the JS side
   * can log what the device will actually do, mirroring
   * [IncomingCallNotificationModule.show]: channel settings are immutable once
   * created, so an install carrying an older channel can post silently.
   */
  @ReactMethod
  fun show(
    conversationId: String,
    senderName: String,
    body: String,
    deepLink: String,
    promise: Promise,
  ) {
    try {
      val manager = notificationManager()
      createNotificationChannel(manager)
      val lines = appendMessage(conversationId, senderName, body)
      manager.notify(
        conversationId,
        notificationId(conversationId),
        buildNotification(conversationId, senderName, deepLink, lines),
      )

      val result = channelAudioState(manager)
      result.putBoolean("shown", true)
      result.putInt("messageCount", lines.size)
      Log.i(
        TAG,
        "Posted message notification conversationId=$conversationId" +
          " importance=${result.getInt("channelImportance")}" +
          " hasSound=${result.getBoolean("channelHasSound")}" +
          " messageCount=${lines.size}",
      )
      promise.resolve(result)
    } catch (error: Exception) {
      Log.e(TAG, "Failed to post message notification conversationId=$conversationId", error)
      promise.reject("MESSAGE_NOTIFICATION_SHOW_FAILED", error)
    }
  }

  /** Dismiss a conversation's notification and forget its stacked messages. */
  @ReactMethod
  fun dismiss(conversationId: String) {
    notificationManager().cancel(conversationId, notificationId(conversationId))
    stackedMessages.remove(conversationId)
    notificationIds.remove(conversationId)
  }

  /** The channel's *effective* importance and sound, post-creation. */
  private fun channelAudioState(manager: NotificationManager): WritableMap {
    val state = Arguments.createMap()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      state.putInt("channelImportance", NotificationManager.IMPORTANCE_DEFAULT)
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
   * Create the messages channel. Versioned exactly like the incoming-call
   * channel, since channel settings are immutable once created and can only be
   * changed on existing installs by publishing a new channel id.
   */
  private fun createNotificationChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel =
      NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_DEFAULT)
    channel.description = "New WeTalk chat messages"
    channel.enableVibration(true)
    channel.setShowBadge(true)
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(
    conversationId: String,
    senderName: String,
    deepLink: String,
    lines: List<StackedMessage>,
  ): Notification {
    val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
    for (line in lines) {
      style.addMessage(line.body, line.receivedAt, Person.Builder().setName(line.sender).build())
    }

    return NotificationCompat
      .Builder(reactContext, CHANNEL_ID)
      .setContentTitle(senderName)
      .setContentText(lines.lastOrNull()?.body ?: "")
      .setSmallIcon(android.R.drawable.ic_dialog_email)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setStyle(style)
      .setGroup(GROUP_KEY)
      .setAutoCancel(true)
      .setContentIntent(contentPendingIntent(conversationId, deepLink))
      .build()
  }

  /** Opens [MainActivity] on the conversation the notification belongs to. */
  private fun contentPendingIntent(
    conversationId: String,
    deepLink: String,
  ): PendingIntent {
    val intent =
      Intent(reactContext, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse(deepLink)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }
    return PendingIntent.getActivity(
      reactContext,
      notificationId(conversationId),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** Append one message to a conversation's stack, keeping the most recent few. */
  private fun appendMessage(
    conversationId: String,
    senderName: String,
    body: String,
  ): List<StackedMessage> {
    val existing = stackedMessages[conversationId] ?: emptyList()
    val appended = existing + StackedMessage(senderName, body, System.currentTimeMillis())
    val trimmed = appended.takeLast(MAX_STACKED_MESSAGES)
    stackedMessages[conversationId] = trimmed
    return trimmed
  }

  /** One line of a conversation's stacked `MessagingStyle` body. */
  private data class StackedMessage(
    val sender: String,
    val body: String,
    val receivedAt: Long,
  )

  companion object {
    const val NAME = "MessageNotification"

    /**
     * Versioned channel id — bump it whenever the channel's importance, sound
     * or vibration settings change, since Android ignores changes made to an
     * existing channel.
     */
    const val CHANNEL_ID = "wetalk_messages.v1"

    private const val TAG = "WeTalkMessageNotification"

    /** Shade group so several conversations bundle instead of listing flat. */
    private const val GROUP_KEY = "com.wetalk.MESSAGES"

    /** Upper bound on the lines kept in one conversation's stacked body. */
    private const val MAX_STACKED_MESSAGES = 6

    private val stackedMessages = ConcurrentHashMap<String, List<StackedMessage>>()
    private val notificationIds = ConcurrentHashMap<String, Int>()
    private val nextNotificationId = AtomicInteger(1)

    /**
     * Stable notification id for a conversation. The conversation id is also
     * used as the notification *tag*, so ids only have to be unique within this
     * module; they are assigned sequentially rather than hashed so two
     * conversations can never collide.
     */
    fun notificationId(conversationId: String): Int =
      notificationIds.computeIfAbsent(conversationId) { nextNotificationId.getAndIncrement() }
  }
}
