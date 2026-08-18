package com.wetalk

import android.content.Context
import android.util.Log

/**
 * Process-death-proof record of (a) which calls this app is currently ringing
 * for and (b) the Accept / Decline the user tapped on WeTalk's branded
 * incoming-call notification.
 *
 * Both are needed because the JS side's queues do not survive process death:
 * `pendingAnswerCallId` in `mobile/src/callKeep.js` lives in a JS module, so a
 * tap that happens while the app is killed — the normal cold-start case — is
 * gone before `useCallFlow` ever mounts. Persisting the tap here lets
 * `useCallFlow` drain it on mount (`consumePendingCallAction`) and complete the
 * accept/decline against the server, whether or not Telecom ever created a
 * CallKeep `Connection` for the call.
 *
 * The ringing record additionally serves as a *trust* signal: [MainActivity]
 * is exported, so an incoming-call intent extra alone cannot be trusted to
 * wake the screen. Only this app can write these preferences, so "we posted a
 * ringing notification for this callId" is as trustworthy as the live-CallKeep-
 * connection check it replaces — and, unlike that check, it still holds on a
 * cold start where Telecom never completed a connection.
 */
object PendingCallStore {
  private const val PREFS_NAME = "com.wetalk.pending_calls"
  private const val KEY_RINGING_CALL_ID = "ringingCallId"
  private const val KEY_RINGING_AT = "ringingAt"
  private const val KEY_ACTION_CALL_ID = "actionCallId"
  private const val KEY_ACTION = "action"
  private const val KEY_ACTION_AT = "actionAt"
  private const val KEY_ACTION_CONNECTION_LIVE = "actionConnectionLive"
  private const val TAG = "WeTalkPendingCall"

  const val ACTION_ACCEPT = "accept"
  const val ACTION_DECLINE = "decline"

  /**
   * How long a persisted tap stays replayable. Beyond this the call has almost
   * certainly timed out server-side, and replaying it would answer a call the
   * user no longer expects to join.
   */
  const val ACTION_TTL_MS = 120_000L

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  /** Record that WeTalk is ringing for [callId]. */
  fun markRinging(
    context: Context,
    callId: String,
  ) {
    prefs(context)
      .edit()
      .putString(KEY_RINGING_CALL_ID, callId)
      .putLong(KEY_RINGING_AT, System.currentTimeMillis())
      .apply()
    Log.i(TAG, "Marked ringing callId=$callId")
  }

  /** Whether WeTalk itself is ringing for [callId] (see class doc: trust signal). */
  fun isRinging(
    context: Context,
    callId: String,
  ): Boolean = prefs(context).getString(KEY_RINGING_CALL_ID, null) == callId

  /** Forget the ringing record for [callId] (call answered/declined/ended). */
  fun clearRinging(
    context: Context,
    callId: String,
  ) {
    if (!isRinging(context, callId)) return
    prefs(context).edit().remove(KEY_RINGING_CALL_ID).remove(KEY_RINGING_AT).apply()
  }

  /**
   * Persist the Accept / Decline the user tapped so the JS call flow can act
   * on it once it is running, even if the tap happened while the app was
   * killed.
   *
   * @param action one of [ACTION_ACCEPT] / [ACTION_DECLINE]
   * @param connectionLive whether a native CallKeep connection existed at tap
   *   time; recorded so the server receipt can distinguish "answered without a
   *   Telecom connection" from a fully-set-up call.
   */
  fun recordAction(
    context: Context,
    callId: String,
    action: String,
    connectionLive: Boolean,
  ) {
    prefs(context)
      .edit()
      .putString(KEY_ACTION_CALL_ID, callId)
      .putString(KEY_ACTION, action)
      .putLong(KEY_ACTION_AT, System.currentTimeMillis())
      .putBoolean(KEY_ACTION_CONNECTION_LIVE, connectionLive)
      .apply()
    Log.i(TAG, "Recorded action=$action callId=$callId connectionLive=$connectionLive")
  }

  /**
   * Remove and return the persisted tap, or `null` when there is none (or it
   * has expired). Expired entries are cleared and logged rather than replayed.
   */
  fun consumeAction(context: Context): PendingAction? {
    val store = prefs(context)
    val callId = store.getString(KEY_ACTION_CALL_ID, null) ?: return null
    val action = store.getString(KEY_ACTION, null)
    val recordedAt = store.getLong(KEY_ACTION_AT, 0L)
    val connectionLive = store.getBoolean(KEY_ACTION_CONNECTION_LIVE, false)
    store
      .edit()
      .remove(KEY_ACTION_CALL_ID)
      .remove(KEY_ACTION)
      .remove(KEY_ACTION_AT)
      .remove(KEY_ACTION_CONNECTION_LIVE)
      .apply()

    if (action == null) return null
    val ageMs = System.currentTimeMillis() - recordedAt
    if (ageMs > ACTION_TTL_MS) {
      Log.w(TAG, "Dropping expired action=$action callId=$callId ageMs=$ageMs")
      return null
    }
    Log.i(TAG, "Draining action=$action callId=$callId ageMs=$ageMs")
    return PendingAction(callId, action, ageMs, connectionLive)
  }

  /** A persisted Accept / Decline tap awaiting replay by the JS call flow. */
  data class PendingAction(
    val callId: String,
    val action: String,
    val ageMs: Long,
    val connectionLive: Boolean,
  )
}
