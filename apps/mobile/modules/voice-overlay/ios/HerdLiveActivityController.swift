import ActivityKit
import UIKit

/// One aggregate activity. Local updates never imply a background socket stays alive.
@MainActor
final class HerdLiveActivityController {
  static let shared = HerdLiveActivityController()
  private var latest: HerdActivityAttributes.ContentState?
  private var voiceGeneration = ""
  private var operation: Task<Void, Never>?
  private var activationObserver: NSObjectProtocol?
  private var authorizationTask: Task<Void, Never>?
  private var actionEmitter: ((String, Bool?, String) -> Bool)?
  private struct PendingAction {
    let action: String
    let desiredMuted: Bool?
    let continuation: CheckedContinuation<Void, Error>
    let timeout: Task<Void, Never>
  }
  private var pendingActions: [UUID: PendingAction] = [:]

  private init() {
    activationObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      Task { @MainActor in self?.enqueue() }
    }
    authorizationTask = Task { [weak self] in
      for await enabled in ActivityAuthorizationInfo().activityEnablementUpdates {
        if !enabled { self?.clear() }
        else { self?.enqueue() }
      }
    }
  }

  func update(mode: String, count: Int, names: String, voiceState: String,
              voiceName: String, muted: Bool) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { clear(); return }
    let safeMode = ["connecting", "offline", "idle", "working", "attention", "finished"].contains(mode) ? mode : "offline"
    let safeVoice = ["disconnected", "connecting", "connected", "thinking", "speaking"].contains(voiceState) ? voiceState : "disconnected"
    latest = .init(mode: safeMode, count: min(999, max(0, count)), names: boundedText(names, utf8Limit: 256),
                   voiceState: safeVoice, voiceName: boundedText(voiceName, utf8Limit: 128),
                   muted: muted, voiceGeneration: voiceGeneration, actionsAvailable: actionEmitter != nil && !voiceGeneration.isEmpty, updatedAt: Date())
    for (id, request) in pendingActions {
      if (request.action == "stop" && safeVoice == "disconnected")
          || (request.action == "mute" && latest?.canControlVoice == true && muted == request.desiredMuted) {
        finishAction(id, error: nil)
      }
    }
    if safeVoice == "disconnected" { cancelActions() }
    enqueue()
  }

  func setVoiceGeneration(_ token: String) {
    // This identity comes from the actual JS call lifecycle, never a React
    // status effect which may coalesce stop and the next start.
    guard token.utf8.count <= 128 else { clear(); return }
    guard token != voiceGeneration else { return }
    if token.isEmpty {
      for (id, request) in pendingActions where request.action == "stop" {
        finishAction(id, error: nil)
      }
    }
    cancelActions()
    voiceGeneration = token
    // Wait for the new call's status; never reuse the old connected snapshot.
    latest?.voiceGeneration = token
    latest?.voiceState = token.isEmpty ? "disconnected" : "connecting"
    latest?.actionsAvailable = false
    enqueue()
  }

  func clear() {
    voiceGeneration = ""
    latest = nil
    cancelActions()
    enqueue()
  }

  func observeActions(_ emitter: ((String, Bool?, String) -> Bool)?) {
    actionEmitter = emitter
    latest?.actionsAvailable = emitter != nil && !voiceGeneration.isEmpty
    if emitter == nil { cancelActions() }
    enqueue()
  }

  func requestAction(_ action: String, generation: String, desiredMuted: Bool? = nil) async throws {
    guard action == "stop" || (action == "mute" && desiredMuted != nil) else {
      throw HerdActivityActionError.unavailable
    }
    guard !generation.isEmpty, generation == voiceGeneration else { throw HerdActivityActionError.unavailable }
    if action == "stop" && latest?.hasVoice != true { return }
    guard let state = latest, state.canControlVoice,
          Date().timeIntervalSince(state.updatedAt) < 60,
          ActivityAuthorizationInfo().areActivitiesEnabled else { throw HerdActivityActionError.unavailable }
    if action == "mute" && state.muted == desiredMuted { return }
    guard let emit = actionEmitter else { throw HerdActivityActionError.unavailable }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let id = UUID()
      let timeout = Task { [weak self] in
        do { try await Task.sleep(nanoseconds: 5_000_000_000) }
        catch { return }
        self?.finishAction(id, error: HerdActivityActionError.unconfirmed)
      }
      pendingActions[id] = PendingAction(action: action, desiredMuted: desiredMuted,
                                         continuation: continuation, timeout: timeout)
      if !emit(action, desiredMuted, generation) { finishAction(id, error: HerdActivityActionError.unavailable) }
    }
  }

  // Scalar boundaries preserve valid Unicode. Even JSON escaping every byte as
  // six characters leaves ample space below ActivityKit's 4 KB content limit.
  private func boundedText(_ text: String, utf8Limit: Int) -> String {
    var result = ""
    var bytes = 0
    for scalar in text.unicodeScalars {
      let part = String(scalar)
      let size = part.utf8.count
      guard bytes + size <= utf8Limit else { break }
      result += part
      bytes += size
    }
    return result
  }

  private func finishAction(_ id: UUID, error: Error?) {
    guard let request = pendingActions.removeValue(forKey: id) else { return }
    request.timeout.cancel()
    if let error { request.continuation.resume(throwing: error) }
    else { request.continuation.resume() }
  }

  private func cancelActions() {
    for id in Array(pendingActions.keys) { finishAction(id, error: HerdActivityActionError.unavailable) }
  }

  private func enqueue() {
    let before = operation
    let state = latest
    operation = Task {
      // ActivityKit operations suspend; ordering prevents a late update reviving logout.
      await before?.value
      await apply(state)
    }
  }

  private func apply(_ state: HerdActivityAttributes.ContentState?) async {
    let activities = Activity<HerdActivityAttributes>.activities
    guard ActivityAuthorizationInfo().areActivitiesEnabled, let state else {
      for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
      return
    }
    // The system marks this snapshot stale if our process stops receiving updates.
    let content = ActivityContent(state: state, staleDate: state.updatedAt.addingTimeInterval(60))
    guard state.isActive else {
      if state.mode == "offline" || state.mode == "connecting" {
        for activity in activities { await activity.update(content) }
        return
      }
      for activity in activities { await activity.end(content, dismissalPolicy: .immediate) }
      return
    }
    if let existing = activities.first {
      await existing.update(content)
      for duplicate in activities.dropFirst() { await duplicate.end(nil, dismissalPolicy: .immediate) }
    } else if UIApplication.shared.applicationState == .active {
      // Starting from a URL never starts capture; this only reflects existing state.
      do { _ = try Activity.request(attributes: HerdActivityAttributes(), content: content, pushType: nil) }
      catch { /* Authorization or system activity limits may change between checks. */ }
    }
  }
}
