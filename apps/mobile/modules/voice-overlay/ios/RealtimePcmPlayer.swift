import AVFoundation

/** Small streaming PCM16 sink for provider-neutral realtime audio. */
final class RealtimePcmPlayer {
  private static let prebufferSeconds = 0.25
  private static let maxQueuedSeconds = 2.0

  private let queue = DispatchQueue(label: "app.muxr.realtime-pcm")
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var format: AVAudioFormat?
  private var sampleRate = 0.0
  private var playing = false
  private var scheduledFrames: Int64 = 0
  private var prebufferFrames: Int64 = 0
  private var maxQueuedFrames: Int64 = 0
  private var turnFinished = false
  private var restartAfterDrain = false
  private var generation: UInt64 = 0

  private var acceptedAdmissions: Int64 = 0
  private var rejectedAdmissions: Int64 = 0
  private var peakQueuedMs = 0.0
  private var underruns: Int64 = 0
  private var drainRestarts: Int64 = 0
  private var clears: Int64 = 0

  func start(sampleRate: Int) -> Bool {
    queue.sync {
      guard [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].contains(sampleRate),
            let nextFormat = AVAudioFormat(
              commonFormat: .pcmFormatInt16,
              sampleRate: Double(sampleRate),
              channels: 1,
              interleaved: false
            ) else { return false }

      stopLocked()
      resetStatsLocked()
      let nextEngine = AVAudioEngine()
      let nextPlayer = AVAudioPlayerNode()
      nextEngine.attach(nextPlayer)
      nextEngine.connect(nextPlayer, to: nextEngine.mainMixerNode, format: nextFormat)
      nextEngine.prepare()
      do {
        try nextEngine.start()
        engine = nextEngine
        player = nextPlayer
        format = nextFormat
        self.sampleRate = Double(sampleRate)
        prebufferFrames = Int64(Double(sampleRate) * Self.prebufferSeconds)
        maxQueuedFrames = Int64(Double(sampleRate) * Self.maxQueuedSeconds)
        generation &+= 1
        return true
      } catch {
        nextEngine.stop()
        return false
      }
    }
  }

  func write(base64: String) -> Bool {
    queue.sync {
      guard let player, let format else { return false }
      guard let data = Data(base64Encoded: base64), !data.isEmpty else {
        return base64.isEmpty
      }
      guard data.count.isMultiple(of: MemoryLayout<Int16>.size) else {
        rejectedAdmissions += 1
        return false
      }

      let frames = Int64(data.count / MemoryLayout<Int16>.size)
      guard frames > 0, frames <= maxQueuedFrames - scheduledFrames else {
        rejectedAdmissions += 1
        return false
      }

      let before = scheduledFrames
      let crossesThreshold = !playing && before < prebufferFrames && before + frames >= prebufferFrames
      let prefixFrames = crossesThreshold ? prebufferFrames - before : frames
      guard let prefix = makeBuffer(
        data: data,
        frameOffset: 0,
        frameCount: Int(prefixFrames),
        format: format
      ) else {
        rejectedAdmissions += 1
        return false
      }
      let remainderFrames = frames - prefixFrames
      let remainder = remainderFrames == 0 ? nil : makeBuffer(
        data: data,
        frameOffset: Int(prefixFrames),
        frameCount: Int(remainderFrames),
        format: format
      )
      guard remainderFrames == 0 || remainder != nil else {
        rejectedAdmissions += 1
        return false
      }

      acceptedAdmissions += 1
      scheduledFrames += frames
      peakQueuedMs = max(peakQueuedMs, Double(scheduledFrames) * 1_000 / sampleRate)
      let current = generation
      schedule(prefix, frames: prefixFrames, generation: current, player: player)
      if crossesThreshold {
        beginPlaybackLocked()
        if let remainder {
          schedule(remainder, frames: remainderFrames, generation: current, player: player)
        }
      } else if let remainder {
        schedule(remainder, frames: remainderFrames, generation: current, player: player)
      }
      if !playing && scheduledFrames >= prebufferFrames {
        beginPlaybackLocked()
      }
      return true
    }
  }

  func finish() -> Bool {
    queue.sync {
      guard player != nil else { return false }
      turnFinished = true
      if scheduledFrames == 0 {
        rearmLocked(restartAfterDrain: false)
      } else if !playing {
        beginPlaybackLocked()
      }
      return true
    }
  }

  func clear() -> Bool {
    queue.sync {
      guard player != nil else { return false }
      clears += 1
      rearmLocked(restartAfterDrain: false)
      return true
    }
  }

  func isDrained() -> Bool {
    queue.sync { scheduledFrames == 0 }
  }

  func stop() -> [String: Double] {
    queue.sync {
      let result = statsLocked()
      stopLocked()
      return result
    }
  }

  private func makeBuffer(
    data: Data,
    frameOffset: Int,
    frameCount: Int,
    format: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    guard frameCount > 0,
          let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
          ),
          let channel = buffer.int16ChannelData?.pointee else { return nil }
    let byteOffset = frameOffset * MemoryLayout<Int16>.size
    let byteCount = frameCount * MemoryLayout<Int16>.size
    var copied = false
    data.withUnsafeBytes { bytes in
      guard let base = bytes.baseAddress else { return }
      channel.withMemoryRebound(to: UInt8.self, capacity: byteCount) { destination in
        destination.update(
          from: base.assumingMemoryBound(to: UInt8.self).advanced(by: byteOffset),
          count: byteCount
        )
      }
      copied = true
    }
    guard copied else { return nil }
    buffer.frameLength = AVAudioFrameCount(frameCount)
    return buffer
  }

  private func schedule(
    _ buffer: AVAudioPCMBuffer,
    frames: Int64,
    generation: UInt64,
    player: AVAudioPlayerNode
  ) {
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      self?.queue.async { [weak self] in
        self?.didRender(frames: frames, generation: generation)
      }
    }
  }

  private func beginPlaybackLocked() {
    guard !playing, scheduledFrames > 0, let player else { return }
    player.play()
    playing = true
    if restartAfterDrain {
      drainRestarts += 1
      restartAfterDrain = false
    }
  }

  private func didRender(frames: Int64, generation: UInt64) {
    guard generation == self.generation else { return }
    scheduledFrames = max(0, scheduledFrames - frames)
    guard playing, scheduledFrames == 0 else { return }
    if turnFinished {
      rearmLocked(restartAfterDrain: false)
    } else {
      underruns += 1
      rearmLocked(restartAfterDrain: true)
    }
  }

  private func rearmLocked(restartAfterDrain: Bool) {
    generation &+= 1
    player?.stop()
    player?.reset()
    playing = false
    scheduledFrames = 0
    turnFinished = false
    self.restartAfterDrain = restartAfterDrain
  }

  private func stopLocked() {
    generation &+= 1
    player?.stop()
    engine?.stop()
    engine?.reset()
    player = nil
    engine = nil
    format = nil
    sampleRate = 0
    playing = false
    scheduledFrames = 0
    prebufferFrames = 0
    maxQueuedFrames = 0
    turnFinished = false
    restartAfterDrain = false
  }

  private func resetStatsLocked() {
    acceptedAdmissions = 0
    rejectedAdmissions = 0
    peakQueuedMs = 0
    underruns = 0
    drainRestarts = 0
    clears = 0
  }

  private func statsLocked() -> [String: Double] {
    [
      "acceptedAdmissions": Double(acceptedAdmissions),
      "rejectedAdmissions": Double(rejectedAdmissions),
      "peakQueuedMs": peakQueuedMs,
      "underruns": Double(underruns),
      "drainRestarts": Double(drainRestarts),
      "clears": Double(clears),
    ]
  }
}
