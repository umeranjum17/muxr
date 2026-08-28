import AVFoundation
import ExpoModulesCore

/** iOS audio bridge; lifecycle notifications remain owned by the OS push path. */
public final class VoiceOverlayModule: Module {
  private let realtimePcm = RealtimePcmPlayer()

  public func definition() -> ModuleDefinition {
    Name("VoiceOverlay")
    Events("onNotificationActionRequested")

    OnDestroy { self.realtimePcm.stop() }

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
    Function("stopService") { true }
    Function("startHerdService") { false }
    Function("stopHerdService") { true }
    Function("updateNotification") {
      (_: String, _: Int, _: String, _: String, _: String, _: String, _: Bool) -> Bool in false
    }
    Function("supportsPromotedNotifications") { false }
    Function("canPostPromotedNotifications") { true }
    Function("openPromotedNotificationSettings") { false }
    Function("openBackgroundActivitySettings") { false }
    Function("clearNotification") { true }
  }
}
