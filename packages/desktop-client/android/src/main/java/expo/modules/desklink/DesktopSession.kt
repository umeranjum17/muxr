package expo.modules.desklink

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SoftwareVideoDecoderFactory
import org.webrtc.VideoDecoder
import org.webrtc.VideoDecoderFactory
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val TAG = "DesklinkSession"

/**
 * One desktop session, native side.
 *
 * Owns its **own** [PeerConnectionFactory] rather than reusing the app's shared
 * WebRTC module, for two reasons:
 *
 *  - the shared factory picks hardware H.264 and *software* VP9/VP8/AV1, so
 *    rendering a desktop through it would decode VP9 on the CPU;
 *  - its decoder factory is process-global and set once, so changing it would
 *    change every other WebRTC user in the app.
 *
 * The factory below asks for [DefaultVideoDecoderFactory], which is
 * hardware-first across VP8/VP9/H264/AV1 with a software fallback, and it is
 * scoped to this session. The underlying WebRTC native library is the app's
 * existing one: this class is compiled against the `org.webrtc` classes the
 * installed binding already ships, so no second copy of the native library is
 * linked in.
 */
class DesktopSession(
  private val context: Context,
  private val eglBase: EglBase.Context,
  private val onEvent: (String, Map<String, Any?>) -> Unit,
) {
  private val io: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "desklink-session")
  }
  private val ui = Handler(Looper.getMainLooper())
  private var inputSeq = 0L

  @Volatile private var factory: PeerConnectionFactory? = null
  @Volatile private var peer: PeerConnection? = null
  @Volatile private var channel: DataChannel? = null
  @Volatile private var videoTrack: VideoTrack? = null
  @Volatile private var epoch: Long = 0
  @Volatile private var closed = false
  private val pendingCandidates = mutableListOf<IceCandidate>()
  @Volatile private var remoteDescriptionSet = false
  @Volatile private var presented = false

  /** The renderer, attached by the view. A sink is (re)registered when it changes. */
  @Volatile var frameSink: ((VideoTrack) -> Unit)? = null

  fun start(iceServersJson: String, relayOnly: Boolean) {
    io.execute {
      if (closed) return@execute
      try {
        val servers = parseIceServers(iceServersJson)
        val configuration = PeerConnection.RTCConfiguration(servers).apply {
          sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
          iceTransportsType = if (relayOnly) {
            PeerConnection.IceTransportsType.RELAY
          } else {
            PeerConnection.IceTransportsType.ALL
          }
        }
        val created = buildFactory()
        factory = created
        val target = ++epoch
        val connection = created.createPeerConnection(configuration, observer(target))
          ?: throw IllegalStateException("WebRTC refused the peer connection configuration")
        peer = connection
        // The engine offers; this side answers. The engine also creates the
        // control channel, so the client waits for it in `onDataChannel`.
        emit("ready", emptyMap())
      } catch (error: Throwable) {
        Log.w(TAG, "Could not start the desktop session", error)
        fail("transport", error.message ?: "the desktop session could not start")
      }
    }
  }

  private fun buildFactory(): PeerConnectionFactory {
    // Initialisation is process-wide and idempotent; the app's binding has
    // already done it, so a second call is tolerated rather than required.
    runCatching {
      PeerConnectionFactory.initialize(
        PeerConnectionFactory.InitializationOptions.builder(context)
          .setEnableInternalTracer(false)
          .createInitializationOptions(),
      )
    }
    // Deliberately no global mutation: the app's shared factory options are left
    // exactly as they were.
    return PeerConnectionFactory.builder()
      .setVideoDecoderFactory(hardwareFirstDecoderFactory())
      .createPeerConnectionFactory()
  }

  /**
   * Hardware-first, VP9 included, with an explicit software fallback so a device
   * without a VP9 hardware decoder still shows the desktop instead of a black
   * rectangle.
   */
  private fun hardwareFirstDecoderFactory(): VideoDecoderFactory =
    DefaultVideoDecoderFactory(eglBase)

  fun setRemoteDescription(type: String, sdp: String) {
    io.execute {
      val connection = peer ?: return@execute
      val target = epoch
      if (type != "offer") {
        fail("transport", "the engine must send an offer")
        return@execute
      }
      connection.setRemoteDescription(
        object : SdpObserver {
          override fun onCreateSuccess(description: SessionDescription?) = Unit

          override fun onSetSuccess() {
            if (target != epoch) return
            remoteDescriptionSet = true
            for (candidate in pendingCandidates) connection.addIceCandidate(candidate)
            pendingCandidates.clear()
            connection.createAnswer(
              object : SdpObserver {
                override fun onCreateSuccess(answer: SessionDescription?) {
                  if (answer == null || target != epoch) return
                  connection.setLocalDescription(
                    object : SdpObserver {
                      override fun onCreateSuccess(description: SessionDescription?) = Unit
                      override fun onSetSuccess() {
                        if (target == epoch) {
                          emit("answer", mapOf("sdp" to answer.description))
                        }
                      }

                      override fun onCreateFailure(error: String?) = fail("transport", error)
                      override fun onSetFailure(error: String?) = fail("transport", error)
                    },
                    answer,
                  )
                }

                override fun onSetSuccess() = Unit
                override fun onCreateFailure(error: String?) = fail("transport", error)
                override fun onSetFailure(error: String?) = fail("transport", error)
              },
              MediaConstraints(),
            )
          }

          override fun onCreateFailure(error: String?) = fail("transport", error)
          override fun onSetFailure(error: String?) = fail("transport", error)
        },
        SessionDescription(SessionDescription.Type.OFFER, sdp),
      )
    }
  }

  fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int) {
    io.execute {
      val connection = peer ?: return@execute
      val ice = IceCandidate(sdpMid, sdpMLineIndex, candidate)
      if (remoteDescriptionSet) {
        connection.addIceCandidate(ice)
      } else {
        pendingCandidates.add(ice)
      }
    }
  }

  /** Stamp and send under one lock: UI gestures and JS use different threads. */
  @Synchronized
  private fun send(message: JSONObject) {
    if (closed) return
    val active = channel ?: return
    if (active.state() != DataChannel.State.OPEN) return
    // Only a move can be replaced by the next one. Dropping an up/cancel would
    // leave input held; clipboard and keyboard messages also need delivery.
    if (active.bufferedAmount() > 256 * 1024 &&
      message.optString("kind") == "pointer" && message.optString("phase") == "move"
    ) return
    message.put("seq", ++inputSeq)
    val sent = active.send(DataChannel.Buffer(
      ByteBuffer.wrap(message.toString().toByteArray(StandardCharsets.UTF_8)), false,
    ))
    if (!sent) {
      fail("transport", "the desktop control channel could not send")
      close()
    }
  }

  fun sendStamped(message: String) = send(JSONObject(message))

  fun sendPointer(phase: String, x: Int, y: Int, withButton: Boolean = false) {
    val message = mutableMapOf<String, Any?>(
      "kind" to "pointer",
      "phase" to phase,
      "x" to x,
      "y" to y,
    )
    if (withButton || phase == "down") message["button"] = 1
    sendJson(message)
  }

  fun sendWheel(dx: Int, dy: Int) {
    sendJson(mapOf("kind" to "wheel", "dx" to dx, "dy" to dy))
  }

  fun sendKey(name: String, modifiers: List<String>, down: Boolean) {
    sendJson(
      mapOf(
        "kind" to "key",
        "name" to name,
        "modifiers" to modifiers,
        "down" to down,
      ),
    )
  }

  /**
   * A chorded character (Ctrl+C). The engine presses the key through the
   * desktop's own layout and holds the named modifiers for that key alone.
   */
  fun sendCharacter(character: String, modifiers: List<String>, down: Boolean) {
    sendJson(
      mapOf(
        "kind" to "key",
        "character" to character,
        "modifiers" to modifiers,
        "down" to down,
      ),
    )
  }

  fun sendText(text: String) {
    sendJson(mapOf("kind" to "text", "text" to text))
  }

  /** Release everything the desktop is holding, without ending the session. */
  fun sendCancel() {
    sendJson(mapOf("kind" to "release_all"))
  }

  fun sendClipboardRead(request: String) {
    sendJson(mapOf("kind" to "clipboard_read", "request" to request))
  }

  fun sendClipboardWrite(request: String, text: String) {
    sendJson(
      mapOf("kind" to "clipboard_write", "request" to request, "text" to text),
    )
  }

  private fun sendJson(message: Map<String, Any?>) {
    send(JSONObject(message))
  }

  fun markPresented() {
    if (!presented) {
      presented = true
      emit("presented", emptyMap())
    }
  }

  @Synchronized
  fun close() {
    if (closed) return
    closed = true
    ++epoch
    io.execute {
      // Releasing everything the far side held is the engine's job on session
      // close; this side only has to stop using the channel.
      runCatching { channel?.unregisterObserver() }
      runCatching { channel?.close() }
      runCatching { channel?.dispose() }
      runCatching { peer?.close() }
      runCatching { peer?.dispose() }
      runCatching { factory?.dispose() }
      channel = null
      peer = null
      factory = null
      pendingCandidates.clear()
      remoteDescriptionSet = false
      emit("closed", emptyMap())
    }
  }

  fun shutdown() {
    close()
    runCatching { io.shutdown() }
  }

  private fun parseIceServers(json: String): List<PeerConnection.IceServer> {
    if (json.isBlank()) return emptyList()
    val array = org.json.JSONArray(json)
    val servers = mutableListOf<PeerConnection.IceServer>()
    for (index in 0 until array.length()) {
      val entry = array.optJSONObject(index) ?: continue
      val urls = entry.optJSONArray("urls") ?: continue
      for (urlIndex in 0 until urls.length()) {
        val url = urls.optString(urlIndex)
        if (url.isBlank()) continue
        val builder = PeerConnection.IceServer.builder(url)
        entry.optString("username").takeIf { it.isNotEmpty() }?.let { builder.setUsername(it) }
        entry.optString("credential").takeIf { it.isNotEmpty() }?.let { builder.setPassword(it) }
        servers.add(builder.createIceServer())
      }
    }
    return servers
  }

  private fun observer(target: Long) = object : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit

    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
      if (target != epoch) return
      emit("ice", mapOf("state" to state?.toString()))
      if (state == PeerConnection.IceConnectionState.CONNECTED &&
        context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
      ) {
        // Bounded debug-build evidence: reception/decoding is not presentation.
        // Never include SDP, addresses, credentials or control payloads.
        for (delay in listOf(2000L, 10000L)) ui.postDelayed({
          if (closed || target != epoch) return@postDelayed
          peer?.getStats { report ->
            val fields = setOf("kind", "packetsReceived", "bytesReceived", "framesReceived",
              "framesDecoded", "keyFramesDecoded", "framesDropped", "framesPerSecond")
            val video = report.statsMap.values.filter { it.type == "inbound-rtp" }
              .map { JSONObject(it.members.filterKeys { key -> key in fields }) }
            Log.i(TAG, "video receive stats: ${org.json.JSONArray(video)}")
          }
        }, delay)
      }
      if (state == PeerConnection.IceConnectionState.FAILED) {
        fail("transport", "the connection to the desktop was lost")
      }
    }

    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) = Unit

    override fun onIceCandidate(candidate: IceCandidate?) {
      if (candidate == null || target != epoch) return
      emit(
        "candidate",
        mapOf(
          "candidate" to candidate.sdp,
          "sdpMid" to candidate.sdpMid,
          "sdpMLineIndex" to candidate.sdpMLineIndex,
        ),
      )
    }

    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
    override fun onAddStream(stream: MediaStream?) = Unit
    override fun onRemoveStream(stream: MediaStream?) = Unit
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit

    override fun onDataChannel(dataChannel: DataChannel?) {
      if (dataChannel == null || target != epoch) return
      channel = dataChannel
      dataChannel.registerObserver(object : DataChannel.Observer {
        override fun onBufferedAmountChange(amount: Long) = Unit

        override fun onStateChange() {
          if (target == epoch) {
            emit("channel", mapOf("state" to dataChannel.state().toString()))
          }
        }

        override fun onMessage(buffer: DataChannel.Buffer) {
          val bytes = ByteArray(buffer.data.remaining())
          buffer.data.get(bytes)
          emit("control", mapOf("message" to String(bytes, StandardCharsets.UTF_8)))
        }
      })
    }

    override fun onTrack(transceiver: RtpTransceiver?) {
      val track = transceiver?.receiver?.track() as? VideoTrack ?: return
      if (target != epoch) return
      videoTrack = track
      Log.i(TAG, "remote video track; view sink registered=${frameSink != null}")
      // A sink can only be attached once; the view attaches it on first layout.
      frameSink?.invoke(track)
      emit("track", emptyMap())
    }
  }

  private fun emit(name: String, payload: Map<String, Any?>) {
    ui.post { onEvent(name, payload) }
  }

  private fun fail(code: String, message: String?) {
    ui.post { onEvent("failure", mapOf("code" to code, "message" to (message ?: "unknown"))) }
  }

  companion object {
    fun newRequestId(): String = UUID.randomUUID().toString()
  }
}
