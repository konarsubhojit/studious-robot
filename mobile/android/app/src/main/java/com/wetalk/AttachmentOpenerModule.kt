package com.wetalk

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class AttachmentOpenerModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  @ReactMethod
  fun open(
    path: String?,
    mimeType: String?,
    name: String?,
    promise: Promise,
  ) {
    if (path.isNullOrBlank()) {
      promise.reject("MISSING_PATH", "Attachment path is missing")
      return
    }

    try {
      val file = File(path)
      val uri: Uri = FileProvider.getUriForFile(
        reactContext,
        "${reactContext.packageName}.fileprovider",
        file,
      )
      val viewIntent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mimeType?.takeIf { it.isNotBlank() } ?: "*/*")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val handlers = reactContext.packageManager.queryIntentActivities(viewIntent, 0)
      if (handlers.isEmpty()) {
        promise.reject("NO_HANDLER", "No installed app can open this attachment")
        return
      }

      val chooser = Intent.createChooser(viewIntent, "Open with…").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      reactContext.startActivity(chooser)
      promise.resolve(null)
    } catch (error: ActivityNotFoundException) {
      promise.reject("NO_HANDLER", error)
    } catch (error: Exception) {
      promise.reject("OPEN_FAILED", error)
    }
  }

  companion object {
    private const val NAME = "AttachmentOpener"
  }
}
