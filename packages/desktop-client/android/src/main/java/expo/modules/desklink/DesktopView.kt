package expo.modules.desklink

import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.view.ViewGroup.LayoutParams
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

  /** Chorded keys that are down on the desktop, by Android key code. */
  private val chordKeysDown = mutableSetOf<Int>()

  init {
    setBackgroundColor(Color.BLACK)
    clipChildren = true
    renderer = buildRenderer()
    // The renderer fills the view and letterboxes the picture itself; the touch
    // mapping works out the letterbox rectangle arithmetically. Positioning the
    // renderer with layout params instead would depend on the parent's layout
    // class, which is not this view's business to assume.
    addView(renderer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(keyboard, LayoutParams(dp(1f), dp(1f)))
    setOnTouchListener { _, event -> handleTouch(event) }
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
          Log.i(TAG, "frame resolution: ${width}x${height}, rotation=$rotation")
          // The engine reports its own geometry over the control channel; this is
          // only used until that arrives.
          if (surfaceWidth == 0 || surfaceHeight == 0) {
            surfaceWidth = if (rotation % 180 == 0) width else height
            surfaceHeight = if (rotation % 180 == 0) height else width
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
    chordKeysDown.clear()
    session = next
    Log.i(TAG, "view session assigned=${next != null}")
    attachSink()
  }

  /** Geometry from the engine, in encoded-surface pixels. */
  fun setSurfaceSize(width: Int, height: Int) {
    if (width <= 0 || height <= 0) return
    if (surfaceWidth == width && surfaceHeight == height) return
    // A new surface size invalidates any held drag: releasing it at coordinates
    // the user never pointed at is worse than letting go.
    if (dragging) session?.sendCancel()
    dragging = false
    pointers = 0
    surfaceWidth = width
    surfaceHeight = height
  }

  /** Called when props are (re)applied, so a late session still gets a renderer. */
  fun requestGeometryRefresh() {
    attachSink()
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
        Log.i(TAG, "video sink attached; view=${width}x${height}")
      }
    }
  }

  fun detachSink() {
    sinkAttached?.removeSink(renderer)
    sinkAttached = null
    session?.frameSink = null
  }

  /**
   * Where the picture actually is, inside a view that fills the screen.
   *
   * The renderer letterboxes with `SCALE_ASPECT_FIT`; this is the same rectangle
   * computed from the two sizes, so a touch maps through the picture rather than
   * through the padded view.
   */
  private fun contentRect(): FloatArray? {
    val viewWidth = width
    val viewHeight = height
    if (viewWidth == 0 || viewHeight == 0 || surfaceWidth == 0 || surfaceHeight == 0) return null
    val scale = min(viewWidth.toFloat() / surfaceWidth, viewHeight.toFloat() / surfaceHeight)
    val renderedWidth = surfaceWidth * scale
    val renderedHeight = surfaceHeight * scale
    return floatArrayOf(
      (viewWidth - renderedWidth) / 2f,
      (viewHeight - renderedHeight) / 2f,
      renderedWidth,
      renderedHeight,
    )
  }

  private fun dp(value: Float): Int = Math.round(value * resources.displayMetrics.density)

  /** Touch → encoded-surface coordinates, or null when the touch is off the picture. */
  private fun point(x: Float, y: Float): Pair<Int, Int>? {
    val rect = contentRect() ?: return null
    val localX = x - rect[0]
    val localY = y - rect[1]
    if (localX < 0 || localY < 0 || localX >= rect[2] || localY >= rect[3]) return null
    val mappedX = Math.floor(localX * surfaceWidth / rect[2].toDouble()).toInt()
    val mappedY = Math.floor(localY * surfaceHeight / rect[3].toDouble()).toInt()
    if (mappedX < 0 || mappedY < 0 || mappedX >= surfaceWidth || mappedY >= surfaceHeight) return null
    return mappedX to mappedY
  }

  private fun handleTouch(event: MotionEvent): Boolean {
    val active = session
    if (active == null) return true

    if (event.pointerCount > 1) {
      if (pointers < 2) {
        if (dragging) {
          point(event.x, event.y)?.let { (x, y) -> active.sendPointer("up", x, y) }
            ?: active.sendCancel()
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
        point(event.x, event.y)?.let { (x, y) -> active.sendPointer("move", x, y) }
        return true
      }

      MotionEvent.ACTION_MOVE -> {
        if (!dragging && hypot((event.x - downX).toDouble(), (event.y - downY).toDouble()) > dp(DRAG_SLOP_DP)) {
          val start = point(downX, downY)
          if (start == null) return true
          active.sendPointer("down", start.first, start.second)
          dragging = true
        }
        if (dragging) {
          point(event.x, event.y)?.let { (x, y) ->
            active.sendPointer("move", x, y, withButton = true)
          }
        }
        return true
      }

      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (dragging) {
          point(event.x, event.y)?.let { (x, y) -> active.sendPointer("up", x, y) }
            ?: active.sendCancel()
        } else if (event.actionMasked == MotionEvent.ACTION_UP) {
          // A tap is a click *at the touched point*: press and release with the
          // same coordinates, so the desktop sees the click where the user aimed.
          point(event.x, event.y)?.let { (x, y) ->
            active.sendPointer("down", x, y)
            active.sendPointer("up", x, y)
          }
        }
        pointers = 0
        dragging = false
        return true
      }
    }
    return true
  }

  private fun releaseAll() {
    session?.sendCancel()
  }

  override fun onDetachedFromWindow() {
    // Unmounting must not leave a button held on the far desktop.
    runCatching { session?.sendCancel() }
    chordKeysDown.clear()
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
      if (forwardChord(event)) return true
      val character = event.unicodeChar
      if (character >= 32) {
        session?.sendText(String(Character.toChars(character)))
        return true
      }
      return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
      if (forwardModifierOrNamedKey(event)) return true
      if (forwardChord(event)) return true
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
          repeat(min(64, beforeLength)) { session?.sendKey("Backspace", emptyList(), true); session?.sendKey("Backspace", emptyList(), false) }
          repeat(min(64, afterLength)) { session?.sendKey("Delete", emptyList(), true); session?.sendKey("Delete", emptyList(), false) }
          return super.deleteSurroundingText(beforeLength, afterLength)
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
          if (forwardModifierOrNamedKey(event)) return true
          if (forwardChord(event)) return true
          return super.sendKeyEvent(event)
        }

        override fun performEditorAction(actionCode: Int): Boolean {
          if (actionCode == EditorInfo.IME_ACTION_DONE || actionCode == EditorInfo.IME_ACTION_GO ||
            actionCode == EditorInfo.IME_ACTION_SEND || actionCode == EditorInfo.IME_ACTION_NEXT
          ) {
            session?.sendKey("Enter", emptyList(), true)
            session?.sendKey("Enter", emptyList(), false)
            return true
          }
          return super.performEditorAction(actionCode)
        }
      }
    }

    /**
     * The letter or digit a chorded key stands for, or null when it is not a
     * chord. `unicodeChar` cannot be used for these: with Control held it is the
     * ASCII control character, not the key the desktop has to press. Alt alone is
     * not a chord: it is how a hardware keyboard composes a character (AltGr).
     */
    private fun chordCharacter(event: KeyEvent): String? {
      if (!event.isCtrlPressed && !event.isMetaPressed) return null
      return chordKeyCharacter(event.keyCode)
    }

    /** The letter or digit a chord key stands for, whatever modifiers are held. */
    private fun chordKeyCharacter(keyCode: Int): String? = when (keyCode) {
      in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> ('a' + (keyCode - KeyEvent.KEYCODE_A)).toString()
      in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> ('0' + (keyCode - KeyEvent.KEYCODE_0)).toString()
      else -> null
    }

    /**
     * Forward a chord key down or up. The up is forwarded even when the
     * modifier that made it a chord was released first; otherwise the desktop
     * keeps the key held and its own key repeat floods it.
     */
    private fun forwardChord(event: KeyEvent): Boolean {
      val chord = chordCharacter(event)
      if (chord != null) {
        val down = event.action == KeyEvent.ACTION_DOWN
        session?.sendCharacter(chord, heldModifiers(event), down = down)
        if (down) chordKeysDown.add(event.keyCode) else chordKeysDown.remove(event.keyCode)
        return true
      }
      if (event.action == KeyEvent.ACTION_UP && chordKeysDown.remove(event.keyCode)) {
        val character = chordKeyCharacter(event.keyCode)
        if (character != null) {
          session?.sendCharacter(character, emptyList(), down = false)
          return true
        }
      }
      return false
    }

    private fun heldModifiers(event: KeyEvent): List<String> {
      val modifiers = mutableListOf<String>()
      if (event.isCtrlPressed) modifiers.add("Control")
      if (event.isAltPressed) modifiers.add("Alt")
      if (event.isMetaPressed) modifiers.add("Meta")
      if (event.isShiftPressed) modifiers.add("Shift")
      return modifiers
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
      session?.sendKey(name, heldModifiers(event), event.action == KeyEvent.ACTION_DOWN)
      return true
    }
  }

}
