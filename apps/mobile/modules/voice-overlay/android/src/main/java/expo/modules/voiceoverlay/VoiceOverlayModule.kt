package expo.modules.voiceoverlay

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

private const val TAG = "VoiceOverlay"

/** Whatever the user is wearing wins; the speaker is only the fallback. */
private val HEADSETS = setOf(
  AudioDeviceInfo.TYPE_WIRED_HEADSET,
  AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
  AudioDeviceInfo.TYPE_USB_HEADSET,
  AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
  AudioDeviceInfo.TYPE_BLE_HEADSET,
)

/** Android audio, service and notification bridge for the live voice session. */
class VoiceOverlayModule : Module() {
  companion object {
    private var activeModule: WeakReference<VoiceOverlayModule>? = null

    internal fun emitNotificationAction(action: String) {
      activeModule?.get()?.sendEvent("onNotificationActionRequested", bundleOf("action" to action))
    }
  }

  init {
    activeModule = WeakReference(this)
  }

  private var routeWatcher: AudioDeviceCallback? = null
  private val realtimePcm = RealtimePcmPlayer()
  private var activityForeground = false
  private var observingNotificationActions = false
  private var pendingActivityAction: String? = null

  private fun context(): Context? = appContext.reactContext

  private fun consumeActivityAction(intent: Intent?) {
    val action = intent?.getStringExtra(VoiceOverlayService.EXTRA_ACTIVITY_ACTION) ?: return
    intent.removeExtra(VoiceOverlayService.EXTRA_ACTIVITY_ACTION)
    pendingActivityAction = action
    flushActivityAction()
  }

  private fun flushActivityAction() {
    if (!activityForeground || !observingNotificationActions) return
    val action = pendingActivityAction ?: return
    pendingActivityAction = null
    sendEvent("onNotificationActionRequested", bundleOf("action" to action))
  }

  private fun audio(): AudioManager? =
    context()?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  private fun applyRoute(manager: AudioManager): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      // setSpeakerphoneOn is deprecated from 12 and ignored after, but it is
      // all there is below that. Off means the headset, when one is present.
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = !manager.isWiredHeadsetOn
      return true
    }
    val devices = manager.availableCommunicationDevices
    val pick = devices.firstOrNull { it.type in HEADSETS }
      ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
      ?: return false
    return manager.setCommunicationDevice(pick)
  }

  /** Headphones get plugged in mid-conversation, so re-pick when they do. */
  private fun watchRoute(manager: AudioManager) {
    if (routeWatcher != null) return
    val watcher = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) {
        runCatching { applyRoute(manager) }
      }

      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) {
        runCatching { applyRoute(manager) }
      }
    }
    manager.registerAudioDeviceCallback(watcher, null)
    routeWatcher = watcher
  }

  override fun definition() = ModuleDefinition {
    Name("VoiceOverlay")
    Events("onNotificationActionRequested")
    OnCreate { consumeActivityAction(appContext.currentActivity?.intent) }
    OnNewIntent(::consumeActivityAction)
    OnActivityEntersForeground {
      activityForeground = true
      consumeActivityAction(appContext.currentActivity?.intent)
      flushActivityAction()
    }
    OnActivityEntersBackground { activityForeground = false }
    OnStartObserving("onNotificationActionRequested") {
      observingNotificationActions = true
      flushActivityAction()
    }
    OnStopObserving("onNotificationActionRequested") {
      observingNotificationActions = false
    }
    OnDestroy { realtimePcm.stop() }

    Function("startRealtimePcm") { sampleRate: Int -> realtimePcm.start(sampleRate) }
    Function("playRealtimePcm") { base64: String -> realtimePcm.write(base64) }
    Function("finishRealtimePcm") { realtimePcm.finish() }
    Function("clearRealtimePcm") { realtimePcm.clear() }
    Function("isRealtimePcmDrained") { realtimePcm.isDrained() }
    Function("stopRealtimePcm") { realtimePcm.stop() }
    Function("isServiceReady") { VoiceOverlayService.isVoiceForegroundReady() }
    Function("setNetworkActive") { active: Boolean ->
      VoiceOverlayService.setNetworkActive(active)
      true
    }

    // The whole Android audio session, so nothing else gets to argue about it.
    // Communication mode is what engages the hardware echo canceller; WebRTC
    // then plays on the voice-call stream, which goes to the earpiece unless
    // something else is named as the communication device.
    Function("routeVoiceAudio") {
      val manager = audio() ?: return@Function false
      runCatching {
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        val routed = applyRoute(manager)
        watchRoute(manager)
        routed
      }.getOrDefault(false)
    }

    Function("releaseVoiceAudio") {
      val manager = audio() ?: return@Function false
      runCatching {
        routeWatcher?.let { manager.unregisterAudioDeviceCallback(it) }
        routeWatcher = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          manager.clearCommunicationDevice()
        } else {
          @Suppress("DEPRECATION")
          manager.isSpeakerphoneOn = false
        }
        manager.mode = AudioManager.MODE_NORMAL
      }
      true
    }

    Function("startService") {
      val context = context() ?: return@Function false
      VoiceOverlayService.prepareVoice()
      val intent = Intent(context, VoiceOverlayService::class.java)
        .setAction(VoiceOverlayService.ACTION_START)
      runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      }.onFailure { Log.e(TAG, "Starting voice microphone service failed", it) }
        .getOrDefault(false)
    }

    Function("stopService") {
      val context = context() ?: return@Function false
      // Deliver ACTION_STOP instead of stopService(): the service decides
      // whether to tear down or downgrade to the herd keepalive. A blunt
      // stopService would kill the keepalive on every voice hangup.
      runCatching {
        context.startService(
          Intent(context, VoiceOverlayService::class.java)
            .setAction(VoiceOverlayService.ACTION_STOP)
        )
        true
      }.onFailure { Log.w(TAG, "Stopping voice microphone service failed", it) }
        .getOrDefault(false)
    }

    Function("startHerdService") {
      val context = context() ?: return@Function false
      val intent = Intent(context, VoiceOverlayService::class.java)
        .setAction(VoiceOverlayService.ACTION_START_HERD)
      runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      }.onFailure { Log.e(TAG, "Starting herd keepalive service failed", it) }
        .getOrDefault(false)
    }

    Function("stopHerdService") {
      val context = context() ?: return@Function false
      runCatching {
        context.startService(
          Intent(context, VoiceOverlayService::class.java)
            .setAction(VoiceOverlayService.ACTION_STOP_HERD)
        )
        true
      }.onFailure { Log.w(TAG, "Stopping herd keepalive service failed", it) }
        .getOrDefault(false)
    }

    Function("updateNotification") {
      mode: String,
      count: Int,
      names: String,
      eventKey: String,
      voiceState: String,
      voiceName: String,
      muted: Boolean ->
      val context = context() ?: return@Function false
      VoiceOverlayService.updateNotification(
        context,
        mode,
        count,
        names,
        eventKey,
        voiceState,
        voiceName,
        muted,
      )
    }

    Function("supportsPromotedNotifications") {
      Build.VERSION.SDK_INT >= 36
    }

    Function("canPostPromotedNotifications") {
      val context = context() ?: return@Function false
      Build.VERSION.SDK_INT < 36 || NotificationManagerCompat.from(context).canPostPromotedNotifications()
    }

    Function("openPromotedNotificationSettings") {
      val context = context() ?: return@Function false
      if (Build.VERSION.SDK_INT < 36) return@Function false
      val promotion = Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val fallback = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:${context.packageName}"),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching {
        context.startActivity(if (promotion.resolveActivity(context.packageManager) != null) promotion else fallback)
        true
      }.onFailure { Log.w(TAG, "Opening Live Updates settings failed", it) }
        .getOrDefault(false)
    }

    Function("openBackgroundActivitySettings") {
      val context = context() ?: return@Function false
      val details = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:${context.packageName}"),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching {
        context.startActivity(details)
        true
      }.onFailure { Log.w(TAG, "Opening background activity settings failed", it) }
        .getOrDefault(false)
    }

    Function("clearNotification") {
      val context = context() ?: return@Function false
      VoiceOverlayService.clearNotification(context)
    }
  }
}
