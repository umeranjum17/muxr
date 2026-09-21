package expo.modules.desklink

import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min

private const val TAG = "DesklinkView"

/** Drag threshold in device pixels below which a touch is a tap, not a drag. */
private const val DRAG_SLOP_DP = 5f

/** Two-finger travel before a scroll is emitted, so a slow pinch does not scroll. */
private const val SCROLL_SLOP_DP = 18f

/**
 * The live desktop surface.
 *
 * Gesture handling lives here rather than in JavaScript on purpose: a pointer
 * drag produces tens of events a second, and routing each one through the
 * bridge would add latency and jitter to the one interaction the user judges the
 * whole feature by. This view owns containment (the surface is letterboxed, and
 * a touch outside the picture is not a desktop coordinate), the tap/drag/scroll
 * decision, the native keyboard, and the release of held state when it is
 * detached.
 */
class DesktopView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val eglBase: EglBase = EglBase.create()
  private var renderer: SurfaceViewRenderer? = null
  private val keyboard = RemoteKeyboard(context)
  private var session: DesktopSession? = null
  private var sinkAttached: VideoTrack? = null

  /** Encoded surface size, reported by the engine through the control channel. */
  private var surfaceWidth = 0
  private var surfaceHeight = 0

  private var downX = 0f
  private var downY = 0f
  private var lastX = 0f
  private var lastY = 0f
  private var dragging = false
  private var pointers = 0

  init {
    setBackgroundColor(Color.BLACK)
    clipChildren = true
    renderer = buildRenderer()
    addView(renderer, FrameLayout.LayoutParams(0, 0))
    addView(keyboard, FrameLayout.LayoutParams(dp(1f), dp(1f), Gravity.BOTTOM or Gravity.START))
    setOnTouchListener { _, event -> handleTouch(event) }
    addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> layoutRenderer() }
  }

  private fun buildRenderer(): SurfaceViewRenderer {
    val view = SurfaceViewRenderer(context)
    view.init(
      eglBase.eglBaseContext,
      object : RendererCommon.RendererEvents {
        override fun onFirstFrameRendered() {
          Log.i(TAG, "first frame rendered")
        }

        override fun onFrameResolutionChanged(width: Int, height: Int, rotation: Int) {
          // The engine reports its own geometry over the control channel; this is
          // only used until that arrives.
          if (surfaceWidth == 0 || surfaceHeight == 0) {
            surfaceWidth = if (rotation % 180 == 0) width else height
            surfaceHeight = if (rotation % 180 == 0) height else width
            post { layoutRenderer() }
          }
          session?.markPresented()
        }
      },
    )
    view.setEnableHardwareScaler(false)
    view.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
    return view
  }

  fun setSession(next: DesktopSession?) {
    if (session === next) return
    detachSink()
    session = next
    attachSink()
    post { layoutRenderer() }
  }

  /** Geometry from the engine, in encoded-surface pixels. */
  fun setSurfaceSize(width: Int, height: Int) {
    if (width <= 0 || height <= 0) return
    if (surfaceWidth == width && surfaceHeight == height) return
    surfaceWidth = width
    surfaceHeight = height
    post { layoutRenderer() }
  }

  /** Called when props are (re)applied, so a late session still gets a renderer. */
  fun requestGeometryRefresh() {
    attachSink()
    post { layoutRenderer() }
  }

  fun showKeyboard() {
    keyboard.requestFocus()
    val service = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    service.showSoftInput(keyboard, InputMethodManager.SHOW_IMPLICIT)
  }

  fun hideKeyboard() {
    val service = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    service.hideSoftInputFromWindow(keyboard.windowToken, 0)
  }

  private fun attachSink() {
    val active = session ?: return
    active.frameSink = { track ->
      if (sinkAttached !== track) {
        sinkAttached?.removeSink(renderer)
        track.addSink(renderer)
        sinkAttached = track
      }
    }
  }

  fun detachSink() {
    sinkAttached?.removeSink(renderer)
    sinkAttached = null
    session?.frameSink = null
  }

  /** Letterbox the renderer inside the view: the picture never stretches. */
  private fun layoutRenderer() {
    val view = renderer ?: return
    val width = width
    val height = height
    if (width == 0 || height == 0 || surfaceWidth == 0 || surfaceHeight == 0) return
    val scale = min(width.toFloat() / surfaceWidth, height.toFloat() / surfaceHeight)
    val renderedWidth = Math.round(surfaceWidth * scale)
    val renderedHeight = Math.round(surfaceHeight * scale)
    val params = view.layoutParams as FrameLayout.LayoutParams
    val left = (width - renderedWidth) / 2
    val top = (height - renderedHeight) / 2
    if (params.width == renderedWidth && params.height == renderedHeight &&
      params.leftMargin == left && params.topMargin == top
    ) {
      return
    }
    // A relayout changes the coordinate mapping, so anything held must be let go
    // rather than released at coordinates the user never pointed at.
    if (dragging) releaseAll()
    pointers = 0
    params.width = renderedWidth
    params.height = renderedHeight
    params.leftMargin = left
    params.topMargin = top
    view.layoutParams = params
  }

  private fun dp(value: Float): Int = Math.round(value * resources.displayMetrics.density)

  /** Touch → encoded-surface coordinates, or null when the touch is off the picture. */
  private fun point(x: Float, y: Float): Pair<Int, Int>? {
    val view = renderer ?: return null
    if (view.width == 0 || view.height == 0) return null
    val localX = x - view.left
    val localY = y - view.top
    if (localX < 0 || localY < 0 || localX >= view.width || localY >= view.height) return null
    val mappedX = Math.floor(localX * surfaceWidth / view.width.toDouble()).toInt()
    val mappedY = Math.floor(localY * surfaceHeight / view.height.toDouble()).toInt()
    if (mappedX < 0 || mappedY < 0 || mappedX >= surfaceWidth || mappedY >= surfaceHeight) return null
    return mappedX to mappedY
  }

  private fun handleTouch(event: MotionEvent): Boolean {
    val active = session
    if (active == null) return true

    if (event.pointerCount > 1) {
      if (pointers < 2) {
        if (dragging) {
          point(event.x, event.y)?.let { (x, y) -> active.sendPointer("up", x, y, active.nextSequence()) }
          dragging = false
        }
        lastY = event.y
      } else if (event.actionMasked == MotionEvent.ACTION_MOVE && surfaceWidth > 0) {
        // Two fingers on a phone mean "scroll the page", which on a desktop means
        // a wheel event, not a pointer drag.
        if (abs(event.y - lastY) > dp(SCROLL_SLOP_DP)) {
          val direction = if (event.y < lastY) 1 else -1
          active.sendWheel(0, direction)
          lastY = event.y
        }
      }
      pointers = event.pointerCount
      return true
    }

    if (pointers > 1) {
      if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
        pointers = 0
      }
      return true
    }

    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pointers = 1
        downX = event.x
        downY = event.y
        dragging = false
        point(event.x, event.y)?.let { (x, y) -> active.sendPointer("move", x, y, touchSequence(active)) }
        return true
      }

      MotionEvent.ACTION_MOVE -> {
        if (!dragging && hypot((event.x - downX).toDouble(), (event.y - downY).toDouble()) > dp(DRAG_SLOP_DP)) {
          val start = point(downX, downY)
          if (start == null) return true
          active.sendPointer("down", start.first, start.second, touchSequence(active))
          dragging = true
        }
        if (dragging) {
          point(event.x, event.y)?.let { (x, y) ->
            active.sendPointer("move", x, y, touchSequence(active), withButton = true)
          }
        }
        return true
      }

      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (dragging) {
          point(event.x, event.y)?.let { (x, y) -> active.sendPointer("up", x, y, touchSequence(active)) }
            ?: active.sendCancel()
        } else if (event.actionMasked == MotionEvent.ACTION_UP) {
          // A tap is a click *at the touched point*: press and release with the
          // same coordinates, so the desktop sees the click where the user aimed.
          point(event.x, event.y)?.let { (x, y) ->
            active.sendPointer("down", x, y, touchSequence(active))
            active.sendPointer("up", x, y, touchSequence(active))
          }
        }
        pointers = 0
        dragging = false
        return true
      }
    }
    return true
  }

  private fun touchSequence(active: DesktopSession): Long = active.nextSequence()

  private fun releaseAll() {
    session?.sendCancel()
  }

  override fun onDetachedFromWindow() {
    // Unmounting must not leave a button held on the far desktop.
    runCatching { session?.sendCancel() }
    detachSink()
    hideKeyboard()
    super.onDetachedFromWindow()
  }

  fun release() {
    detachSink()
    renderer?.release()
    runCatching { eglBase.release() }
  }

  /**
   * A transparent single-line editor that exists only to own the input
   * connection: the platform's keyboard, composing region and selection model
   * are the user's, and forwarding the *committed* text keeps them intact.
   */
  private inner class RemoteKeyboard(context: Context) : EditText(context) {
    init {
      background = null
      setTextColor(Color.TRANSPARENT)
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
      isSingleLine = true
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
      if (forwardModifierOrNamedKey(event)) return true
      val character = event.unicodeChar
      if (character >= 32 && !event.isCtrlPressed) {
        session?.sendText(String(Character.toChars(character)))
        return true
      }
      return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
      if (forwardModifierOrNamedKey(event)) return true
      return super.onKeyUp(keyCode, event)
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
      val base = super.onCreateInputConnection(outAttrs) ?: return null
      return object : InputConnectionWrapper(base, true) {
        override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
          if (!text.isNullOrEmpty()) session?.sendText(text.toString())
          return super.commitText(text, newCursorPosition)
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
          // Backspace and forward-delete are real keys, not edits to a local
          // buffer: the desktop owns the text.
          repeat(min(64, beforeLength)) { session?.sendKey("Backspace", true); session?.sendKey("Backspace", false) }
          repeat(min(64, afterLength)) { session?.sendKey("Delete", true); session?.sendKey("Delete", false) }
          return super.deleteSurroundingText(beforeLength, afterLength)
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
          if (forwardModifierOrNamedKey(event)) return true
          return super.sendKeyEvent(event)
        }

        override fun performEditorAction(actionCode: Int): Boolean {
          if (actionCode == EditorInfo.IME_ACTION_DONE || actionCode == EditorInfo.IME_ACTION_GO ||
            actionCode == EditorInfo.IME_ACTION_SEND || actionCode == EditorInfo.IME_ACTION_NEXT
          ) {
            session?.sendKey("Enter", true)
            session?.sendKey("Enter", false)
            return true
          }
          return super.performEditorAction(actionCode)
        }
      }
    }

    /**
     * Modifiers and keys with no character travel as key events so the desktop
     * sees the real chord — Ctrl+C has to be Ctrl+C there, not a pasted "c".
     */
    private fun forwardModifierOrNamedKey(event: KeyEvent): Boolean {
      val name = when (event.keyCode) {
        KeyEvent.KEYCODE_CTRL_LEFT -> "Control"
        KeyEvent.KEYCODE_CTRL_RIGHT -> "ControlRight"
        KeyEvent.KEYCODE_SHIFT_LEFT -> "Shift"
        KeyEvent.KEYCODE_SHIFT_RIGHT -> "ShiftRight"
        KeyEvent.KEYCODE_ALT_LEFT -> "Alt"
        KeyEvent.KEYCODE_ALT_RIGHT -> "AltGraph"
        KeyEvent.KEYCODE_META_LEFT, KeyEvent.KEYCODE_META_RIGHT -> "Meta"
        KeyEvent.KEYCODE_DEL -> "Backspace"
        KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
        KeyEvent.KEYCODE_ENTER -> "Enter"
        KeyEvent.KEYCODE_TAB -> "Tab"
        KeyEvent.KEYCODE_ESCAPE -> "Escape"
        KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
        KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
        KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
        KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
        KeyEvent.KEYCODE_MOVE_HOME -> "Home"
        KeyEvent.KEYCODE_MOVE_END -> "End"
        KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
        KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
        else -> return false
      }
      session?.sendKey(name, event.action == KeyEvent.ACTION_DOWN)
      return true
    }
  }

}
