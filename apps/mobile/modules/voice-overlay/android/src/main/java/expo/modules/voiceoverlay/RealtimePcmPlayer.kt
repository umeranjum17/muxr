package expo.modules.voiceoverlay

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Small streaming PCM16 sink for provider WebSocket transports. */
internal class RealtimePcmPlayer {
  private val writes = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    ArrayBlockingQueue(8),
    ThreadPoolExecutor.DiscardOldestPolicy(),
  )
  @Volatile private var track: AudioTrack? = null

  fun start(sampleRate: Int): Boolean {
    if (sampleRate !in setOf(8000, 16000, 22050, 24000, 32000, 44100, 48000)) return false
    stop()
    val minimum = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minimum <= 0) return false
    val next = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(minimum * 4, sampleRate))
      .build()
    if (next.state != AudioTrack.STATE_INITIALIZED) {
      next.release()
      return false
    }
    track = next
    next.play()
    return true
  }

  fun write(base64: String): Boolean {
    val active = track ?: return false
    val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return false
    if (bytes.isEmpty()) return true
    writes.execute {
      if (track === active) active.write(bytes, 0, bytes.size, AudioTrack.WRITE_BLOCKING)
    }
    return true
  }

  fun clear(): Boolean {
    val active = track ?: return false
    writes.queue.clear()
    writes.execute {
      if (track === active) runCatching {
        active.pause()
        active.flush()
        active.play()
      }
    }
    return true
  }

  fun stop() {
    val active = track ?: return
    track = null
    writes.queue.clear()
    writes.execute {
      runCatching { active.pause() }
      runCatching { active.flush() }
      runCatching { active.stop() }
      active.release()
    }
  }
}
