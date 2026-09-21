package expo.modules.desklink

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The client half of the desktop package.
 *
 * The module owns session objects; the view owns the pixels and the gestures.
 * Everything an application does goes through this small surface:
 * open → negotiate → show → drive → close.
 */
class DesklinkModule : Module() {
  private val sessions = mutableMapOf<String, DesktopSession>()
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
      views[id]?.showKeyboard()
      true
    }

    Function("hideKeyboard") { id: String ->
      views[id]?.hideKeyboard()
      true
    }

    Function("setSurfaceSize") { id: String, width: Int, height: Int ->
      views[id]?.setSurfaceSize(width, height)
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

  private val views = mutableMapOf<String, DesktopView>()

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
