import ActivityKit
import UIKit

/// One aggregate activity. Local updates never imply a background socket stays alive.
@MainActor
final class HerdLiveActivityController {
  static let shared = HerdLiveActivityController()
  private var latest: HerdActivityAttributes.ContentState?
  private var voiceGeneration = UUID().uuidString
  private var operation: Task<Void, Never>?
  private var activationObserver: NSObjectProtocol?
  private var authorizationTask: Task<Void, Never>?
  private var actionEmitter: ((String, Bool?) -> Bool)?
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
      for await _ in ActivityAuthorizationInfo().activityEnablementUpdates {
        self?.enqueue()
      }
    }
  }

  func update(mode: String, count: Int, names: String, voiceState: String,
              voiceName: String, muted: Bool) {
    let safeMode = ["connecting", "offline", "idle", "working", "attention", "finished"].contains(mode) ? mode : "offline"
    let safeVoice = ["disconnected", "connecting", "connected", "thinking", "speaking"].contains(voiceState) ? voiceState : "disconnected"
    // A retained widget action must never target a later voice conversation.
    if safeVoice == "disconnected" || latest?.hasVoice != true {
      voiceGeneration = UUID().uuidString
    }
    latest = .init(mode: safeMode, count: min(999, max(0, count)), names: String(names.prefix(160)),
                   voiceState: safeVoice, voiceName: String(voiceName.prefix(80)),
                   muted: muted, voiceGeneration: voiceGeneration, actionsAvailable: actionEmitter != nil, updatedAt: Date())
    for (id, request) in pendingActions {
      if (request.action == "stop" && safeVoice == "disconnected")
          || (request.action == "mute" && latest?.canControlVoice == true && muted == request.desiredMuted) {
        finishAction(id, error: nil)
      }
    }
    if safeVoice == "disconnected" { cancelActions() }
    enqueue()
  }

  func clear() {
    voiceGeneration = UUID().uuidString
    latest = nil
    cancelActions()
    enqueue()
  }

  func observeActions(_ emitter: ((String, Bool?) -> Bool)?) {
    actionEmitter = emitter
    latest?.actionsAvailable = emitter != nil
    if emitter == nil { cancelActions() }
    enqueue()
  }

  func requestAction(_ action: String, generation: String, desiredMuted: Bool? = nil) async throws {
    guard action == "stop" || (action == "mute" && desiredMuted != nil) else {
      throw HerdActivityActionError.unavailable
    }
    guard generation == voiceGeneration else { throw HerdActivityActionError.unavailable }
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
      if !emit(action, desiredMuted) { finishAction(id, error: HerdActivityActionError.unavailable) }
    }
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
