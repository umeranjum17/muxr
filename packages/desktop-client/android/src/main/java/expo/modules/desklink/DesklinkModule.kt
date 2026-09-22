package expo.modules.desklink

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap

/**
 * The client half of the desktop package.
 *
 * The module owns session objects; the view owns the pixels and the gestures.
 * Everything an application does goes through this small surface:
 * open → negotiate → show → drive → close.
 */
class DesklinkModule : Module() {
  private val sessions = ConcurrentHashMap<String, DesktopSession>()
  private var nextId = 0

  private val eglContext = lazy {
    // One shared EGL context for every session's renderer: a second display
    // connection would cost a GPU context per session for no benefit.
    org.webrtc.EglBase.create().eglBaseContext
  }

  override fun definition() = ModuleDefinition {
    Name("Desklink")

    Events("onSessionEvent")

    Function("createSession") { iceServersJson: String?, relayOnly: Boolean? ->
      val context = appContext.reactContext ?: return@Function null
      val id = "desklink-${++nextId}"
      val session = DesktopSession(
        context = context,
        eglBase = eglContext.value,
        onEvent = { name, payload -> emit(name, id, payload) },
      )
      sessions[id] = session
      session.start(iceServersJson ?: "[]", relayOnly ?: false)
      id
    }

    Function("setRemoteDescription") { id: String, type: String, sdp: String ->
      sessions[id]?.setRemoteDescription(type, sdp)
      true
    }

    Function("addRemoteCandidate") { id: String, candidate: String, sdpMid: String?, sdpMLineIndex: Int? ->
      sessions[id]?.addRemoteCandidate(candidate, sdpMid, sdpMLineIndex ?: 0)
      true
    }

    Function("sendControl") { id: String, message: String ->
      sessions[id]?.sendStamped(message)
      true
    }

    Function("showKeyboard") { id: String ->
      postToView(id) { it.showKeyboard() }
      true
    }

    Function("hideKeyboard") { id: String ->
      postToView(id) { it.hideKeyboard() }
      true
    }

    Function("setSurfaceSize") { id: String, width: Int, height: Int ->
      postToView(id) { it.setSurfaceSize(width, height) }
      true
    }

    Function("closeSession") { id: String ->
      sessions.remove(id)?.shutdown()
      views.remove(id)
      true
    }

    Function("isAvailable") { true }

    View(DesktopView::class) {
      Name("DesklinkSurface")

      Prop("sessionId") { view: DesktopView, id: String? ->
        val session = id?.let { sessions[it] }
        view.setSession(session)
        if (id != null) views[id] = view
      }

      OnViewDestroys { view: DesktopView -> view.release() }

      OnViewDidUpdateProps { view: DesktopView ->
        // Props are applied before the view is measured; a session that arrived
        // with the prop has to be told about the view it will render into.
        view.requestGeometryRefresh()
      }
    }

    OnDestroy {
      for (session in sessions.values) session.shutdown()
      sessions.clear()
      views.clear()
    }
  }

  private val views = ConcurrentHashMap<String, DesktopView>()

  // Synchronous module functions run on JS, not Android's UI thread. Ignore
  // queued work if the session/view was closed or replaced in the meantime.
  private fun postToView(id: String, action: (DesktopView) -> Unit) {
    views[id]?.let { view ->
      view.post { if (views[id] === view) action(view) }
    }
  }

  private fun emit(name: String, id: String, payload: Map<String, Any?>) {
    sendEvent(
      "onSessionEvent",
      mapOf(
        "sessionId" to id,
        "name" to name,
        "payload" to payload,
      ),
    )
  }
}
