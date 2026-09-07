import ActivityKit
import Foundation

struct HerdActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var mode: String
    var count: Int
    var names: String
    var voiceState: String
    var voiceName: String
    var muted: Bool
    var voiceGeneration: String
    var actionsAvailable: Bool
    var updatedAt: Date

    var hasVoice: Bool { voiceState != "disconnected" }
    var canControlVoice: Bool { ["connected", "thinking", "speaking"].contains(voiceState) }
    var isActive: Bool { mode == "working" || mode == "attention" || hasVoice }
    var title: String {
      if hasVoice {
        switch voiceState {
        case "connecting": return "Connecting voice"
        case "thinking": return "Thinking"
        case "speaking": return "Speaking"
        default: return muted ? "Voice muted" : "Voice connected"
        }
      }
      switch mode {
      case "working": return count == 1 ? "1 agent working" : "\(count) agents working"
      case "attention": return "Needs your attention"
      case "connecting": return "Reconnecting"
      case "offline": return "Computer offline"
      case "finished": return "Work finished"
      default: return "All caught up"
      }
    }
    var symbol: String {
      if hasVoice { return muted ? "mic.slash.fill" : "waveform" }
      if mode == "attention" { return "exclamationmark.bubble.fill" }
      if mode == "offline" || mode == "connecting" { return "wifi.slash" }
      return mode == "working" ? "terminal.fill" : "checkmark.circle.fill"
    }
    var detail: String { hasVoice ? voiceName : names }
  }
}
