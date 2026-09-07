import AppIntents
import Foundation

enum HerdActivityActionError: Error, LocalizedError {
  case unavailable, unconfirmed
  var errorDescription: String? {
    switch self {
    case .unavailable: return "Open muxr to control the voice conversation."
    case .unconfirmed: return "The voice action was not confirmed. Open muxr to check its state."
    }
  }
}

@available(iOS 17.0, *)
struct HerdMuteIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Set voice mute"
  static var openAppWhenRun = false
  @Parameter(title: "Conversation") var generation: String
  @Parameter(title: "Muted") var desiredMuted: Bool
  init() { desiredMuted = true; generation = "" }
  init(desiredMuted: Bool, generation: String) { self.desiredMuted = desiredMuted; self.generation = generation }
  func perform() async throws -> some IntentResult {
    #if HERD_WIDGET_EXTENSION
    // LiveActivityIntent should execute its app implementation. Never pretend
    // success if the system cannot discover or run that implementation.
    throw HerdActivityActionError.unavailable
    #else
    try await HerdLiveActivityController.shared.requestAction("mute", generation: generation, desiredMuted: desiredMuted)
    #endif
    return .result()
  }
}

@available(iOS 17.0, *)
struct HerdStopIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Stop voice"
  static var openAppWhenRun = false
  @Parameter(title: "Conversation") var generation: String
  init() { generation = "" }
  init(generation: String) { self.generation = generation }
  func perform() async throws -> some IntentResult {
    #if HERD_WIDGET_EXTENSION
    throw HerdActivityActionError.unavailable
    #else
    try await HerdLiveActivityController.shared.requestAction("stop", generation: generation)
    #endif
    return .result()
  }
}
