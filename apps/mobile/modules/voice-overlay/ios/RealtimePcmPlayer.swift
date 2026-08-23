import AVFoundation

/** Small streaming PCM16 sink for provider-neutral realtime audio. */
final class RealtimePcmPlayer {
  private let queue = DispatchQueue(label: "app.muxr.realtime-pcm")
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var format: AVAudioFormat?

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
      let nextEngine = AVAudioEngine()
      let nextPlayer = AVAudioPlayerNode()
      nextEngine.attach(nextPlayer)
      nextEngine.connect(nextPlayer, to: nextEngine.mainMixerNode, format: nextFormat)
      nextEngine.prepare()
      do {
        try nextEngine.start()
        nextPlayer.play()
        engine = nextEngine
        player = nextPlayer
        format = nextFormat
        return true
      } catch {
        nextEngine.stop()
        return false
      }
    }
  }

  func write(base64: String) -> Bool {
    queue.sync {
      guard let player, let format, let data = Data(base64Encoded: base64), !data.isEmpty else {
        return base64.isEmpty
      }
      let frames = data.count / MemoryLayout<Int16>.size
      guard frames > 0,
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
            let channel = buffer.int16ChannelData?.pointee else { return false }
      data.withUnsafeBytes { bytes in
        guard let source = bytes.bindMemory(to: Int16.self).baseAddress else { return }
        channel.update(from: source, count: frames)
      }
      buffer.frameLength = AVAudioFrameCount(frames)
      player.scheduleBuffer(buffer)
      if !player.isPlaying { player.play() }
      return true
    }
  }

  func clear() -> Bool {
    queue.sync {
      guard let player else { return false }
      player.stop()
      player.reset()
      player.play()
      return true
    }
  }

  func stop() {
    queue.sync { stopLocked() }
  }

  private func stopLocked() {
    player?.stop()
    engine?.stop()
    engine?.reset()
    player = nil
    engine = nil
    format = nil
  }
}
