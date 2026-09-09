package expo.modules.voiceoverlay

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import java.util.ArrayDeque
import java.util.concurrent.Executors

private const val PREBUFFER_MS = 250
private const val MAX_QUEUED_MS = 2_000
private const val WRITE_SLICE_MS = 20
private const val DRAIN_POLL_MS = 20L
private const val TAG = "RealtimePcmPlayer"

/** Small streaming PCM16 sink for provider WebSocket transports. */
internal class RealtimePcmPlayer {
  private data class Chunk(val bytes: ByteArray, var offset: Int = 0)

  private class Playback(
    val generation: Long,
    val track: AudioTrack,
    val sampleRate: Int,
  ) {
    val queue = ArrayDeque<Chunk>()
    val prebufferBytes = sampleRate * PREBUFFER_MS / 1000 * 2
    val maxQueuedBytes = sampleRate * 2 * MAX_QUEUED_MS / 1000
    val sliceBytes = maxOf(2, sampleRate * 2 * WRITE_SLICE_MS / 1000)
    var outstandingBytes = 0L
    var writtenBytes = 0L
    var pausedBytes = 0
    var lastPlaybackHead = track.playbackHeadPosition.toLong() and 0xffffffffL
    var playing = false
    var finishing = false
    var restartPending = false
    var workerScheduled = false
    var delayed: Runnable? = null
  }

  private val executor = Executors.newSingleThreadExecutor()
  private val handler = Handler(Looper.getMainLooper())
  private var generation = 0L
  private var playback: Playback? = null

  private var acceptedAdmissions = 0L
  private var rejectedAdmissions = 0L
  private var peakQueuedMs = 0.0
  private var underruns = 0L
  private var drainRestarts = 0L
  private var clears = 0L

  @Synchronized
  fun start(sampleRate: Int): Boolean {
    if (sampleRate !in setOf(8000, 16000, 22050, 24000, 32000, 44100, 48000)) return false
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
      .setBufferSizeInBytes(maxOf(minimum * 4, sampleRate * PREBUFFER_MS / 1000 * 4))
      .build()
    if (next.state != AudioTrack.STATE_INITIALIZED) {
      next.release()
      return false
    }

    val previous = detachLocked()
    resetStatsLocked()
    playback = Playback(++generation, next, sampleRate)
    previous?.let(::releaseLater)
    return true
  }

  fun write(base64: String): Boolean {
    val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull()
    synchronized(this) {
      val active = playback ?: return false
      if (bytes == null || bytes.size % 2 != 0) {
        rejectedAdmissions++
        return false
      }
      if (bytes.isEmpty()) return true
      refreshRenderedLocked(active)
      if (active.outstandingBytes + bytes.size > active.maxQueuedBytes) {
        rejectedAdmissions++
        return false
      }
      acceptedAdmissions++
      active.queue.addLast(Chunk(bytes))
      active.outstandingBytes += bytes.size
      peakQueuedMs = maxOf(
        peakQueuedMs,
        active.outstandingBytes * 1000.0 / (active.sampleRate * 2),
      )
      scheduleWorkerLocked(active)
      return true
    }
  }

  @Synchronized
  fun finish(): Boolean {
    val active = playback ?: return false
    refreshRenderedLocked(active)
    if (!active.playing && active.queue.isEmpty() && active.pausedBytes == 0) {
      cancelDelayedLocked(active)
      active.finishing = false
      active.restartPending = false
      return true
    }
    active.finishing = true
    scheduleWorkerLocked(active)
    return true
  }

  @Synchronized
  fun clear(): Boolean {
    val previous = playback ?: return false
    cancelDelayedLocked(previous)
    val next = Playback(++generation, previous.track, previous.sampleRate)
    playback = next
    clears++
    executor.execute {
      runCatching { previous.track.pause() }
      runCatching { previous.track.flush() }
      synchronized(this) {
        if (playback === next) {
          next.lastPlaybackHead = next.track.playbackHeadPosition.toLong() and 0xffffffffL
          if (next.queue.isNotEmpty() || next.finishing) scheduleWorkerLocked(next)
        }
      }
    }
    return true
  }

  @Synchronized
  fun isDrained(): Boolean {
    val active = playback ?: return true
    refreshRenderedLocked(active)
    if (active.outstandingBytes != 0L) return false
    // A true drain is the JS boundary acknowledgement. Rearm while holding the
    // same lock so audio admitted immediately afterwards cannot slip onto the
    // still-playing track and bypass the next turn's prebuffer.
    if (active.playing) rearmLocked(active, midTurn = !active.finishing)
    return true
  }

  @Synchronized
  fun stop(): Map<String, Double> {
    val previous = detachLocked()
    previous?.let(::releaseLater)
    return statsLocked()
  }

  private fun drain(active: Playback) {
    while (true) {
      val work = synchronized(this) {
        if (playback !== active) return
        val chunk = active.queue.peekFirst()
        if (chunk == null) {
          if (!active.playing && active.finishing && active.pausedBytes > 0) startLocked(active)
          active.workerScheduled = false
          scheduleDrainPollLocked(active)
          return
        }
        val remaining = chunk.bytes.size - chunk.offset
        val length = if (active.playing) {
          minOf(remaining, active.sliceBytes)
        } else {
          minOf(remaining, active.prebufferBytes - active.pausedBytes)
        }
        Triple(chunk, chunk.offset, length)
      }

      val mode = synchronized(this) {
        if (playback !== active) return
        if (active.playing) AudioTrack.WRITE_BLOCKING else AudioTrack.WRITE_NON_BLOCKING
      }
      val written = active.track.write(work.first.bytes, work.second, work.third, mode)
      synchronized(this) {
        if (playback !== active) return
        if (written < 0) {
          Log.w(TAG, "Native PCM write failed: $written")
          active.workerScheduled = false
          failLocked(active)
          return
        }
        if (written == 0) {
          active.workerScheduled = false
          scheduleDelayedLocked(active, 5L)
          return
        }
        work.first.offset += written
        active.writtenBytes += written
        if (!active.playing) active.pausedBytes += written
        if (work.first.offset == work.first.bytes.size) active.queue.removeFirst()
        if (!active.playing && active.pausedBytes == active.prebufferBytes) startLocked(active)
      }
    }
  }

  private fun checkDrain(active: Playback) {
    synchronized(this) {
      if (playback !== active) return
      refreshRenderedLocked(active)
      if (active.playing && active.queue.isEmpty() && active.writtenBytes == 0L) {
        rearmLocked(active, midTurn = !active.finishing)
      } else {
        scheduleDrainPollLocked(active)
      }
    }
  }

  private fun startLocked(active: Playback) {
    if (playback !== active || active.playing || active.pausedBytes == 0) return
    val started = runCatching {
      active.track.play()
      active.track.playState == AudioTrack.PLAYSTATE_PLAYING
    }.getOrDefault(false)
    if (!started) {
      failLocked(active)
      return
    }
    active.playing = true
    if (active.restartPending) {
      drainRestarts++
      active.restartPending = false
    }
    scheduleDrainPollLocked(active)
  }

  private fun refreshRenderedLocked(active: Playback) {
    if (!active.playing) return
    val head = active.track.playbackHeadPosition.toLong() and 0xffffffffL
    val frames = (head - active.lastPlaybackHead) and 0xffffffffL
    active.lastPlaybackHead = head
    val rendered = minOf(active.writtenBytes, frames * 2)
    active.writtenBytes -= rendered
    active.outstandingBytes = maxOf(0L, active.outstandingBytes - rendered)
  }

  private fun rearmLocked(active: Playback, midTurn: Boolean) {
    cancelDelayedLocked(active)
    runCatching { active.track.pause() }
    runCatching { active.track.flush() }
    active.playing = false
    active.finishing = false
    active.pausedBytes = 0
    active.writtenBytes = 0
    active.outstandingBytes = 0
    active.lastPlaybackHead = active.track.playbackHeadPosition.toLong() and 0xffffffffL
    if (midTurn) {
      underruns++
      active.restartPending = true
    } else {
      active.restartPending = false
    }
  }

  private fun failLocked(active: Playback) {
    if (playback !== active) return
    cancelDelayedLocked(active)
    playback = null
    generation++
    releaseLater(active)
  }

  private fun scheduleWorkerLocked(active: Playback) {
    cancelDelayedLocked(active)
    if (playback !== active || active.workerScheduled) return
    active.workerScheduled = true
    executor.execute { drain(active) }
  }

  private fun scheduleDrainPollLocked(active: Playback) {
    if (playback !== active || !active.playing || active.delayed != null) return
    scheduleDelayedLocked(active, DRAIN_POLL_MS) { checkDrain(active) }
  }

  private fun scheduleDelayedLocked(
    active: Playback,
    delayMs: Long,
    action: () -> Unit = { synchronized(this) { scheduleWorkerLocked(active) } },
  ) {
    cancelDelayedLocked(active)
    val expectedGeneration = active.generation
    val delayed = Runnable {
      synchronized(this) {
        if (playback !== active || generation != expectedGeneration) return@Runnable
        active.delayed = null
      }
      executor.execute { action() }
    }
    active.delayed = delayed
    handler.postDelayed(delayed, delayMs)
  }

  private fun cancelDelayedLocked(active: Playback) {
    active.delayed?.let(handler::removeCallbacks)
    active.delayed = null
  }

  private fun detachLocked(): Playback? {
    val previous = playback ?: return null
    cancelDelayedLocked(previous)
    playback = null
    generation++
    return previous
  }

  private fun releaseLater(active: Playback) {
    executor.execute {
      runCatching { active.track.pause() }
      runCatching { active.track.flush() }
      runCatching { active.track.stop() }
      active.track.release()
    }
  }

  private fun resetStatsLocked() {
    acceptedAdmissions = 0
    rejectedAdmissions = 0
    peakQueuedMs = 0.0
    underruns = 0
    drainRestarts = 0
    clears = 0
  }

  private fun statsLocked(): Map<String, Double> = mapOf(
    "acceptedAdmissions" to acceptedAdmissions.toDouble(),
    "rejectedAdmissions" to rejectedAdmissions.toDouble(),
    "peakQueuedMs" to peakQueuedMs,
    "underruns" to underruns.toDouble(),
    "drainRestarts" to drainRestarts.toDouble(),
    "clears" to clears.toDouble(),
  )
}
