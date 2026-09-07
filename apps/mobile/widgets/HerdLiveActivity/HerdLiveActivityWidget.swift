import ActivityKit
import SwiftUI
import WidgetKit

@main
struct HerdLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: HerdActivityAttributes.self) { context in
      HStack(spacing: 14) {
        Image(systemName: context.isStale ? "arrow.clockwise" : context.state.symbol)
          .font(.title2).foregroundStyle(.tint).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 4) {
          Text(context.isStale ? "Open muxr to refresh" : context.state.title).font(.headline)
          if !context.isStale && !context.state.detail.isEmpty {
            Text(context.state.detail).font(.subheadline).lineLimit(2).privacySensitive()
          }
          Text("muxr").font(.caption).foregroundStyle(.secondary)
          if #available(iOS 17.0, *), context.state.actionsAvailable && context.state.canControlVoice && !context.isStale {
            HerdVoiceActions(muted: context.state.muted, generation: context.state.voiceGeneration)
          }
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").foregroundStyle(.secondary).accessibilityHidden(true)
      }
      .padding(16)
      .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
      .widgetURL(URL(string: "muxr://"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: context.isStale ? "arrow.clockwise" : context.state.symbol)
            .font(.title2).accessibilityLabel(context.isStale ? "Needs refresh" : context.state.title)
        }
        DynamicIslandExpandedRegion(.trailing) { Text("muxr").font(.caption.bold()) }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 4) {
            Text(context.isStale ? "Open muxr to refresh" : context.state.title).font(.headline)
            if !context.isStale && !context.state.detail.isEmpty {
              Text(context.state.detail).font(.caption).lineLimit(2).privacySensitive()
            }
            if #available(iOS 17.0, *), context.state.actionsAvailable && context.state.canControlVoice && !context.isStale {
              HerdVoiceActions(muted: context.state.muted, generation: context.state.voiceGeneration)
            }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Image(systemName: context.isStale ? "arrow.clockwise" : context.state.symbol)
      } compactTrailing: {
        if context.isStale { Text("…") }
        else if context.state.hasVoice { Image(systemName: context.state.muted ? "mic.slash" : "waveform") }
        else { Text(context.state.count, format: .number).monospacedDigit() }
      } minimal: {
        Image(systemName: context.isStale ? "arrow.clockwise" : context.state.symbol)
      }
      .widgetURL(URL(string: "muxr://"))
      .keylineTint(.cyan)
    }
  }
}

@available(iOS 17.0, *)
private struct HerdVoiceActions: View {
  let muted: Bool
  let generation: String
  var body: some View {
    HStack {
      Button(intent: HerdMuteIntent(desiredMuted: !muted, generation: generation)) {
        Label(muted ? "Unmute" : "Mute", systemImage: muted ? "mic.fill" : "mic.slash.fill")
      }
      Button(intent: HerdStopIntent(generation: generation)) { Label("Stop", systemImage: "stop.fill") }
    }.buttonStyle(.bordered)
  }
}
