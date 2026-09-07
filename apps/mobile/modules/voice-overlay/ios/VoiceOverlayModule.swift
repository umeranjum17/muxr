import AVFoundation
import ActivityKit
import ExpoModulesCore
import UIKit

/** Native audio and local Live Activities; remote notifications remain on APNs. */
public final class VoiceOverlayModule: Module {
  private let realtimePcm = RealtimePcmPlayer()

  public func definition() -> ModuleDefinition {
    Name("VoiceOverlay")
    Events("onNotificationActionRequested")
    OnStartObserving {
      DispatchQueue.main.async { [weak self] in
        HerdLiveActivityController.shared.observeActions { [weak self] action, desiredMuted in
          guard let self else { return false }
          var payload: [String: Any] = ["action": action]
          if let desiredMuted { payload["desiredMuted"] = desiredMuted }
          self.sendEvent("onNotificationActionRequested", payload)
          return true
        }
      }
    }
    OnStopObserving {
      DispatchQueue.main.async { HerdLiveActivityController.shared.observeActions(nil) }
    }

    OnDestroy {
      self.realtimePcm.stop()
      DispatchQueue.main.async {
        HerdLiveActivityController.shared.observeActions(nil)
        HerdLiveActivityController.shared.clear()
      }
    }

    Function("startRealtimePcm") { (sampleRate: Int) -> Bool in
      self.realtimePcm.start(sampleRate: sampleRate)
    }
    Function("playRealtimePcm") { (base64: String) -> Bool in
      self.realtimePcm.write(base64: base64)
    }
    Function("clearRealtimePcm") { () -> Bool in self.realtimePcm.clear() }
    Function("finishRealtimePcm") { () -> Bool in self.realtimePcm.finish() }
    Function("isRealtimePcmDrained") { () -> Bool in self.realtimePcm.isDrained() }
    Function("stopRealtimePcm") { () -> [String: Double] in self.realtimePcm.stop() }

    Function("routeVoiceAudio") { () -> Bool in
      let session = AVAudioSession.sharedInstance()
      do {
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothA2DP, .defaultToSpeaker]
        #if compiler(>=6.2)
        options.insert(.allowBluetoothHFP)
        #else
        options.insert(.allowBluetooth)
        #endif
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        try session.setActive(true)
        return true
      } catch {
        return false
      }
    }

    Function("releaseVoiceAudio") { () -> Bool in
      do {
        try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return true
      } catch {
        return false
      }
    }

    // iOS has no Android-style foreground service. These keep the shared JS
    // lifecycle platform-blind while APNs owns background agent notifications.
    Function("startService") { true }
    Function("setNetworkActive") { (_: Bool) -> Bool in true }
    Function("stopService") { true }
    Function("startHerdService") { false }
    Function("stopHerdService") { true }
    Function("updateNotification") {
      (mode: String, count: Int, names: String, _: String, voiceState: String, voiceName: String, muted: Bool) -> Bool in
      DispatchQueue.main.async {
        HerdLiveActivityController.shared.update(mode: mode, count: count, names: names,
          voiceState: voiceState, voiceName: voiceName, muted: muted)
      }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }
    Function("supportsPromotedNotifications") {
      if #available(iOS 16.2, *) { return true }
      return false
    }
    Function("canPostPromotedNotifications") { ActivityAuthorizationInfo().areActivitiesEnabled }
    Function("openPromotedNotificationSettings") {
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return false }
      Task { @MainActor in UIApplication.shared.open(url) }
      return true
    }
    Function("openBackgroundActivitySettings") { false }
    Function("clearNotification") {
      DispatchQueue.main.async { HerdLiveActivityController.shared.clear() }
      return true
    }
  }
}
