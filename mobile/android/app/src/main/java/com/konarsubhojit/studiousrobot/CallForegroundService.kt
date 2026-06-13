package com.konarsubhojit.studiousrobot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Lightweight foreground service that keeps an active call running while the app
 * is backgrounded. It posts an ongoing notification and declares camera/microphone
 * foreground service types so capture can continue in the background.
 */
class CallForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    createNotificationChannel()
    val notification = buildNotification()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val serviceType =
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      startForeground(NOTIFICATION_ID, notification, serviceType)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    return START_STICKY
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        val channel =
          NotificationChannel(
            CHANNEL_ID,
            "Ongoing calls",
            NotificationManager.IMPORTANCE_LOW,
          )
        channel.description = "Keeps active calls running while the app is in the background"
        manager.createNotificationChannel(channel)
      }
    }
  }

  private fun buildNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("studious-robot")
      .setContentText("Call in progress")
      .setSmallIcon(android.R.drawable.ic_menu_call)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .build()

  companion object {
    const val CHANNEL_ID = "studious_robot_calls"
    // Fixed, app-unique notification id for the single ongoing-call notification.
    const val NOTIFICATION_ID = 4173
  }
}
