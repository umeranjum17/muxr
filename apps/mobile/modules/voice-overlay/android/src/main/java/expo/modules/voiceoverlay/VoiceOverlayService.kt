package expo.modules.voiceoverlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import java.lang.ref.WeakReference

/** Keeps the microphone legal while voice is live and owns the herd Live Update. */
class VoiceOverlayService : Service() {
  companion object {
    const val ACTION_START = "voiceOverlay.start"
    const val ACTION_STOP = "voiceOverlay.stop"
    const val ACTION_MUTE = "voiceOverlay.mute"
    internal const val ACTION_START_HERD = "voiceOverlay.herdStart"
    internal const val ACTION_STOP_HERD = "voiceOverlay.herdStop"
    internal const val EXTRA_NOTIFICATION_ACTION = "voiceOverlay.notificationAction"
    internal const val EXTRA_ACTIVITY_ACTION = "voiceOverlay.activityAction"

    private const val STATUS_CHANNEL_ID = "voice_session"
    private const val ATTENTION_CHANNEL_ID = "herd_attention"
    private const val HERD_NOTIFICATION_ID = 0x0B
    private const val VOICE_NOTIFICATION_ID = 0x0C
    private const val HERD_GROUP_KEY = "muxr.herd"

    private var instance: WeakReference<VoiceOverlayService>? = null
    private var herdMode = "offline"
    private var herdCount = 0
    private var herdName = ""
    private var herdNames = ""
    private var herdEventKey = ""
    private var lastAttentionKeys = emptySet<String>()
    private var lastFinishedKey = ""
    private var pendingEventAlert = false
    /**
     * True while the app wants the herd link kept alive: the service stays
     * foreground (dataSync) even with no voice session, so Android never
     * freezes the process and the socket/widget keep tracking the herd.
     */
    private var herdKeepalive = false
    private var voiceState = "disconnected"
    private var voiceName = ""
    private var voiceMuted = false
    private var voiceStartedAt = 0L
    /**
     * Notification posts are coalesced: the JS side re-sends the whole herd
     * state on every store update (several per second with a busy herd), and
     * Android rate-limits and SHEDS enqueues past a few per second -- the
     * widget then goes stale despite the keepalive. Visible-state signature
     * skips no-op posts; the interval cap with a trailing flush bounds the
     * rest.
     */
    private var lastPostedSignature = ""
    private var lastPostAt = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingFlush: Runnable? = null
    private const val MIN_POST_INTERVAL_MS = 1500L

    internal fun prepareVoice() {
      mainHandler.post {
        voiceState = "connecting"
        voiceMuted = false
        if (voiceStartedAt == 0L) voiceStartedAt = System.currentTimeMillis()
      }
    }

    internal fun updateNotification(
      context: Context,
      mode: String,
      count: Int,
      names: String,
      eventKey: String,
      state: String,
      activeVoiceName: String,
      muted: Boolean,
    ): Boolean {
      val appContext = context.applicationContext
      mainHandler.post {
        herdMode = mode
        herdCount = count.coerceAtLeast(0)
        herdNames = names.trim().replace(Regex("\\s+"), " ").take(160)
        herdName = herdNames.substringBefore(',').trim().take(80)
        herdEventKey = eventKey.trim().take(200)
        val newEventAlert = when (mode) {
          "attention" -> {
            val current = herdEventKey.removePrefix("attention:").split(",").filter(String::isNotBlank).toSet()
            val alert = current.any { it !in lastAttentionKeys }
            lastAttentionKeys = current
            lastFinishedKey = ""
            alert
          }
          "finished" -> {
            lastAttentionKeys = emptySet()
            val alert = herdEventKey.isNotBlank() && herdEventKey != lastFinishedKey
            lastFinishedKey = herdEventKey
            alert
          }
          else -> {
            lastAttentionKeys = emptySet()
            lastFinishedKey = ""
            false
          }
        }
        pendingEventAlert = if (mode == "attention" || mode == "finished") pendingEventAlert || newEventAlert else false
        voiceState = state
        voiceName = activeVoiceName.trim().take(80)
        voiceMuted = muted
        if (state != "disconnected" && voiceStartedAt == 0L) voiceStartedAt = System.currentTimeMillis()
        if (state == "disconnected") voiceStartedAt = 0L

        if (mode != "working" && mode != "attention") herdKeepalive = false
        doRequestPost(appContext)
      }
      return true
    }

    private fun visibleSignature(): String =
      listOf(herdMode, herdCount, herdNames, herdEventKey, voiceState, voiceName, voiceMuted).joinToString("|")

    /**
     * All visible notification state and throttle state is confined to the
     * main looper so a trailing flush cannot publish a partially updated herd.
     */
    private fun requestPost(context: Context) {
      if (Looper.myLooper() === Looper.getMainLooper()) {
        doRequestPost(context)
      } else {
        mainHandler.post { doRequestPost(context) }
      }
    }

    private fun doRequestPost(context: Context) {
      val signature = visibleSignature()
      if (signature == lastPostedSignature) return
      val wait = lastPostAt + MIN_POST_INTERVAL_MS - SystemClock.uptimeMillis()
      if (wait > 0) {
        // One trailing flush at most; it re-reads the latest state when it
        // fires, and clearNotification can cancel it.
        if (pendingFlush != null) return
        val flush = Runnable {
          pendingFlush = null
          requestPost(context)
        }
        pendingFlush = flush
        mainHandler.postDelayed(flush, wait)
        return
      }
      lastPostAt = SystemClock.uptimeMillis()
      lastPostedSignature = signature
      val service = instance?.get()
      if (service != null) {
        service.refreshNotification()
      } else if (herdMode == "finished") {
        postHerdNotification(context)
      } else if (herdMode != "working" && herdMode != "attention") {
        manager(context).cancel(HERD_NOTIFICATION_ID)
      }
    }

    internal fun clearNotification(context: Context): Boolean {
      // Logout: kill any coalesced post still in flight, or a trailing flush
      // reposts the herd (agent names included) a second later. Resetting the
      // signature also lets the next real post through instead of it being
      // deduped against what was on screen before the logout. The reset runs
      // on the main looper, in order with any pending flush.
      val appContext = context.applicationContext
      mainHandler.post {
        pendingFlush?.let(mainHandler::removeCallbacks)
        pendingFlush = null
        lastPostedSignature = ""
        lastPostAt = 0L
        pendingEventAlert = false
        lastAttentionKeys = emptySet()
        lastFinishedKey = ""
        manager(appContext).run {
          cancel(HERD_NOTIFICATION_ID)
          cancel(VOICE_NOTIFICATION_ID)
        }
      }
      return true
    }

    private fun manager(context: Context): NotificationManager =
      context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun smallIcon(context: Context): Int {
      val resource = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      return if (resource != 0) resource else context.applicationInfo.icon
    }

    private fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      manager(context).run {
        createNotificationChannel(
          NotificationChannel(STATUS_CHANNEL_ID, "Herd status and voice", NotificationManager.IMPORTANCE_LOW),
        )
        createNotificationChannel(
          NotificationChannel(ATTENTION_CHANNEL_ID, "Herd activity", NotificationManager.IMPORTANCE_DEFAULT),
        )
      }
    }

    private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
      context,
      0,
      requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName)),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun startVoice(context: Context): PendingIntent {
      val intent = requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(EXTRA_ACTIVITY_ACTION, "start")
      return PendingIntent.getActivity(
        context,
        1,
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }

    private fun stopVoice(context: Context): PendingIntent = PendingIntent.getService(
      context,
      2,
      Intent(context, VoiceOverlayService::class.java)
        .setAction(ACTION_STOP)
        .putExtra(EXTRA_NOTIFICATION_ACTION, true),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun muteVoice(context: Context): PendingIntent = PendingIntent.getService(
      context,
      3,
      Intent(context, VoiceOverlayService::class.java)
        .setAction(ACTION_MUTE)
        .putExtra(EXTRA_NOTIFICATION_ACTION, true),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun shortStatus(activeVoice: Boolean): String? {
      if (activeVoice) return when {
        voiceMuted -> "Muted"
        voiceState == "speaking" -> "Speak"
        voiceState == "thinking" -> "Think"
        else -> "Live"
      }
      return when (herdMode) {
        "attention" -> "Needs"
        "working" -> if (herdCount in 1..9) "$herdCount busy" else "Busy"
        "offline" -> "Offline"
        "connecting" -> "Linking"
        else -> null
      }
    }

    private fun voiceStatus(): String = when {
      voiceMuted -> "Microphone muted"
      voiceState == "speaking" -> "Speaking"
      voiceState == "thinking" -> "Thinking"
      voiceState == "connecting" -> "Connecting"
      else -> "Listening"
    }

    private fun herdTitle(): String = when (herdMode) {
      "attention" -> if (herdCount == 1) "${herdName.ifBlank { "An agent" }} needs you" else "$herdCount agents need you"
      "working" -> if (herdCount == 1) "${herdName.ifBlank { "An agent" }} is working" else "$herdCount agents working"
      "finished" -> if (herdCount == 1) "${herdName.ifBlank { "An agent" }} finished" else "$herdCount agents finished"
      "offline" -> "Host unreachable"
      "connecting" -> "Connecting to host"
      else -> "Herd quiet"
    }

    private fun herdBody(): String = when (herdMode) {
      "attention" -> "Open muxr to respond"
      "working" -> if (herdCount > 1 && herdNames.isNotBlank()) herdNames else "Work in progress"
      "finished" -> if (herdCount > 1 && herdNames.isNotBlank()) herdNames else "Work completed"
      "offline" -> "Check the host or network connection"
      "connecting" -> "Reconnecting…"
      else -> "Nothing is running"
    }

    private fun publicHerdStatus(): String = when (herdMode) {
      "attention" -> if (herdCount == 1) "An agent needs you" else "$herdCount agents need you"
      "working" -> if (herdCount == 1) "1 agent working" else "$herdCount agents working"
      "finished" -> if (herdCount == 1) "Work finished" else "$herdCount agents finished"
      "offline" -> "Host unreachable"
      "connecting" -> "Connecting to host"
      else -> "Herd quiet"
    }

    private fun publicNotification(context: Context, text: String, activeVoice: Boolean): Notification {
      val builder = NotificationCompat.Builder(context, STATUS_CHANNEL_ID)
        .setContentTitle(if (activeVoice) "muxr Voice" else "muxr")
        .setContentText(text)
        .setSmallIcon(smallIcon(context))
        .setContentIntent(openApp(context))
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      if (activeVoice) {
        builder
          .setOngoing(true)
          .addAction(0, "Hang Up", stopVoice(context))
          .addAction(0, if (voiceMuted) "Unmute" else "Mute", muteVoice(context))
      }
      return builder.build()
    }

    private fun buildNotification(context: Context, activeVoice: Boolean): Notification {
      ensureChannels(context)
      val event = !activeVoice && pendingEventAlert
      val promote = activeVoice || herdMode == "working" || herdMode == "attention"
      val title = if (activeVoice && voiceName.isNotBlank()) "Voice with $voiceName"
        else if (activeVoice) "muxr Voice" else herdTitle()
      val body = if (activeVoice) voiceStatus() else herdBody()
      val builder = NotificationCompat.Builder(context, if (activeVoice) STATUS_CHANNEL_ID else ATTENTION_CHANNEL_ID)
        .setContentTitle(title)
        .setContentText(body)
        .setSmallIcon(smallIcon(context))
        .setContentIntent(openApp(context))
        .setGroup(HERD_GROUP_KEY)
        .setOnlyAlertOnce(!event)
        .setSilent(!event)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPublicVersion(publicNotification(context, if (activeVoice) voiceStatus() else publicHerdStatus(), activeVoice))
        .setOngoing(promote)
        .setRequestPromotedOngoing(promote)
        .setAutoCancel(!promote)
      shortStatus(activeVoice)?.let(builder::setShortCriticalText)
      if (activeVoice) {
        builder
          .setWhen(voiceStartedAt)
          .setUsesChronometer(true)
          .addAction(0, "Hang Up", stopVoice(context))
          .addAction(0, if (voiceMuted) "Unmute" else "Mute", muteVoice(context))
          .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      } else if (herdMode == "attention") {
        builder
          .addAction(0, "Open", openApp(context))
          .addAction(0, "Talk", startVoice(context))
      } else {
        builder.addAction(0, "Talk", startVoice(context))
      }
      return builder.build()
    }

    private fun postHerdNotification(context: Context) {
      runCatching {
        manager(context).notify(HERD_NOTIFICATION_ID, buildNotification(context, false))
        pendingEventAlert = false
      }.onFailure { Log.w("VoiceOverlay", "herd notification failed", it) }
    }

  }

  override fun onCreate() {
    super.onCreate()
    instance = WeakReference(this)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /**
   * dataSync foreground services get six hours per day on API 35+; past the
   * budget the system calls this and crashes the app with a
   * RemoteServiceException when the service keeps running. Stop cleanly
   * instead -- the widget falls back to last-known state until the app is next
   * opened and restarts the keepalive.
   *
   * This is the dataSync/mediaProcessing callback (API 35). The single-argument
   * `onTimeout` is the shortService one and is never called for this service,
   * so it is deliberately not overridden. `stopSelf()` without a startId: a
   * later start command (mute, hang up, keepalive) would make the id-scoped
   * form a no-op, and the system crashes us if we do not actually stop.
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    herdKeepalive = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notificationAction = intent?.getBooleanExtra(EXTRA_NOTIFICATION_ACTION, false) == true
    if (intent?.action == ACTION_MUTE) {
      if (notificationAction) VoiceOverlayModule.emitNotificationAction("mute")
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_START_HERD) {
      herdKeepalive = true
      // No mic session to hide behind: become foreground as dataSync so
      // Android never freezes the process and the herd socket stays live.
      if (voiceState == "disconnected") {
        foregroundHerd()
      } else {
        runCatching {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
              VOICE_NOTIFICATION_ID,
              buildNotification(this, true),
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
          } else {
            startForeground(VOICE_NOTIFICATION_ID, buildNotification(this, true))
          }
        }.onFailure {
          Log.w("VoiceOverlay", "voice foreground refresh refused", it)
          VoiceOverlayModule.emitNotificationAction("stop")
          voiceState = "disconnected"
          voiceName = ""
          voiceStartedAt = 0L
          resetCommunicationAudio()
          foregroundHerd()
        }
      }
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP_HERD) {
      herdKeepalive = false
      if (voiceState == "disconnected") {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP) {
      if (notificationAction) VoiceOverlayModule.emitNotificationAction("stop")
      resetCommunicationAudio()
      if (herdKeepalive) {
        // A queued coalesced refresh still sees the old voice state until JS
        // reports disconnected; cancel it before it can repost a stale voice
        // card after the foreground id changes.
        pendingFlush?.let(mainHandler::removeCallbacks)
        pendingFlush = null
        // Voice hangs up but the herd link stays: swap the mic foreground
        // notification for the herd one instead of tearing down. Android may
        // ignore cancellation of the still-active foreground notification, so
        // switch ids before cancelling the old voice card.
        foregroundHerd()
        manager(this).cancel(VOICE_NOTIFICATION_ID)
      } else {
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (herdMode == "finished") postHerdNotification(this)
        stopSelf()
      }
      return START_NOT_STICKY
    }

    var foregroundStarted = false
    try {
      manager(this).cancel(HERD_NOTIFICATION_ID)
      configureCommunicationAudio()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          VOICE_NOTIFICATION_ID,
          buildNotification(this, true),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        )
      } else {
        startForeground(VOICE_NOTIFICATION_ID, buildNotification(this, true))
      }
      foregroundStarted = true
    } catch (error: Throwable) {
      Log.w("VoiceOverlay", "microphone foreground service refused", error)
      resetCommunicationAudio()
      // The mic was refused, but that must not take the herd link down with
      // it: fall back to the dataSync keepalive (which reposts the herd
      // notification cancelled above) instead of stopping the service.
      if (herdKeepalive) foregroundHerd() else stopSelf()
    }
    if (notificationAction && foregroundStarted) VoiceOverlayModule.emitNotificationAction("start")
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (instance?.get() === this) instance = null
    voiceState = "disconnected"
    voiceName = ""
    voiceStartedAt = 0L
    resetCommunicationAudio()
    // Only an authenticated herd keeps a notification after teardown; logout
    // already cleared everything and must not see a stale one reposted.
    if (herdKeepalive) postHerdNotification(this)
    super.onDestroy()
  }

  private fun configureCommunicationAudio() {
    val audio = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    @Suppress("DEPRECATION")
    audio.isSpeakerphoneOn = true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.availableCommunicationDevices
        .firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        ?.let(audio::setCommunicationDevice)
    }
  }

  private fun resetCommunicationAudio() {
    val audio = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.clearCommunicationDevice()
      @Suppress("DEPRECATION")
      audio.isSpeakerphoneOn = false
      audio.mode = AudioManager.MODE_NORMAL
    }
  }

  /**
   * Foreground as dataSync, or tear down. A refusal (background start, blown
   * FGS budget) must never leave the service running: the caller has already
   * cancelled the mic notification, so the alternative is an invisible
   * microphone-typed foreground service the user cannot stop.
   */
  private fun foregroundHerd() {
    runCatching {
      val notification = buildNotification(this, false)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          HERD_NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
      } else {
        startForeground(HERD_NOTIFICATION_ID, notification)
      }
      pendingEventAlert = false
    }.onFailure {
      Log.w("VoiceOverlay", "herd foreground service refused", it)
      herdKeepalive = false
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun refreshNotification() {
    runCatching {
      if (voiceState != "disconnected") {
        manager(this).notify(VOICE_NOTIFICATION_ID, buildNotification(this, true))
      } else if (herdMode == "working" || herdMode == "attention") {
        manager(this).notify(HERD_NOTIFICATION_ID, buildNotification(this, false))
        pendingEventAlert = false
      } else {
        // A settled lifecycle is no longer a foreground-service reason. Remove
        // the ongoing card, replace it once with the dismissible completion,
        // and stop so Android cannot resurrect it after dismissal.
        herdKeepalive = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (herdMode == "finished") {
          manager(this).notify(HERD_NOTIFICATION_ID, buildNotification(this, false))
          pendingEventAlert = false
        } else {
          manager(this).cancel(HERD_NOTIFICATION_ID)
        }
        stopSelf()
      }
    }.onFailure { Log.w("VoiceOverlay", "voice notification update failed", it) }
  }
}
