package expo.modules.desklink

import android.content.Context
import android.graphics.Color
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.ViewConfiguration
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.view.ViewGroup.LayoutParams
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import org.webrtc.VideoTrack
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

private const val TAG = "DesklinkView"

/** The closest the picture can be zoomed: surface pixels per desktop pixel. */
private const val MAX_SCALE = 2.5f

/**
 * Desktop pixels one wheel detent stands for, so a two-finger scroll moves the
 * content about as far as the fingers moved at any zoom.
 */
private const val PIXELS_PER_DETENT = 120f

/** Wheel steps smaller than this wait for more movement rather than flood the channel. */
private const val MIN_WHEEL_STEP = 0.05f

/**
 * The live desktop surface.
 *
 * Gesture handling lives here rather than in JavaScript on purpose: a pointer
 * drag produces tens of events a second, and routing each one through the
 * bridge would add latency and jitter to the one interaction the user judges the
 * whole feature by. This view owns the picture's zoom and position, the gesture
 * decisions, the native keyboard, and the release of held state when it is
 * detached.
 *
 * The gestures are the ones mature remote-desktop viewers settled on:
 *
 *  - tap: click where the finger lands; two taps: a double click on the same spot;
 *  - press and hold: a right click on release, or drag after it to hold the left
 *    button (select text, move a window);
 *  - one finger: move around a zoomed-in desktop;
 *  - two fingers: scroll the desktop under them, or pinch to zoom (and move) the
 *    picture; a quick two-finger tap is a right click.
 */
class DesktopView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var surfaceView: SurfaceView? = null
  private var renderer: DesktopRenderer? = null
  private val keyboard = RemoteKeyboard(context)
  private var session: DesktopSession? = null
  private var sinkAttached: VideoTrack? = null

  /** Encoded surface size, reported by the engine through the control channel. */
  private var surfaceWidth = 0
  private var surfaceHeight = 0

  // The picture's placement: surface pixels per desktop pixel, and where the
  // desktop's top-left corner sits in this view. `fitted` keeps a picture that
  // was showing the whole desktop showing it when the view changes size.
  private var scale = 1f
  private var originX = 0f
  private var originY = 0f
  private var fitted = true

  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  /**
   * How close a second tap lands to count as a double click on the first
   * tap's point. The platform's double-tap slop (100 dp) spans a third of a
   * fitted 4K desktop, which would merge taps on different targets.
   */
  private val doubleTapSlop = dp(40f).toFloat()

  private enum class Gesture { NONE, PENDING, PAN, ARMED, DRAG, TWO, PINCH, SCROLL, SPENT }

  private var gesture = Gesture.NONE
  private var downX = 0f
  private var downY = 0f
  private var lastX = 0f
  private var lastY = 0f
  private var twoStart = 0L
  private var startSpan = 0f
  private var lastSpan = 0f
  private var startFocusX = 0f
  private var startFocusY = 0f
  private var lastFocusX = 0f
  private var lastFocusY = 0f
  private var wheelX = 0f
  private var wheelY = 0f
  private var lastTapAt = 0L
  private var lastTapX = 0f
  private var lastTapY = 0f
  private var lastTapPoint: Pair<Int, Int>? = null

  /** A held finger arms the right click and the left-button drag. */
  private val longPress = Runnable {
    if (gesture != Gesture.PENDING) return@Runnable
    val at = point(downX, downY) ?: return@Runnable
    gesture = Gesture.ARMED
    session?.sendPointer("move", at.first, at.second)
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
  }

  /** While the app holds a sticky modifier, what the keyboard types is the app's to chord. */
  private var keyboardCaptured = false

  /** Chorded keys that are down on the desktop, by Android key code. */
  private val chordKeysDown = mutableSetOf<Int>()

  init {
    setBackgroundColor(Color.BLACK)
    clipChildren = true
    addView(keyboard, LayoutParams(dp(1f), dp(1f)))
    setOnTouchListener { _, event -> handleTouch(event) }
  }

  fun setSession(next: DesktopSession?) {
    if (session === next) return
    detachSink()
    cancelGesture()
    chordKeysDown.clear()
    keyboardCaptured = false
    // The view goes first: its surface callbacks run on the renderer's thread,
    // which must still be there to answer them.
    surfaceView?.let { removeView(it) }
    renderer?.release()
    renderer = null
    surfaceView = null
    session = next
    if (next != null) {
      // Hardware decoder frames are GPU textures; the renderer shares the
      // session's EGL context so it can read them.
      val created = DesktopRenderer(
        next.eglBase,
        onFirstFrame = { post { Log.i(TAG, "first frame presented"); session?.markPresented() } },
        onFrameSize = { width, height -> post { adoptFrameSize(width, height) } },
      )
      renderer = created
      surfaceView = SurfaceView(context).also {
        it.holder.addCallback(created)
        addView(it, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      }
      layoutPicture()
    }
    Log.i(TAG, "view session assigned=${next != null}")
    attachSink()
  }

  /** Geometry from the engine, in encoded-surface pixels. */
  fun setSurfaceSize(width: Int, height: Int) {
    if (width <= 0 || height <= 0) return
    if (surfaceWidth == width && surfaceHeight == height) return
    // A new surface size invalidates any held drag: releasing it at coordinates
    // the user never pointed at is worse than letting go.
    if (gesture == Gesture.DRAG) session?.sendCancel()
    cancelGesture()
    surfaceWidth = width
    surfaceHeight = height
    fitted = true
    layoutPicture()
  }

  /** The decoded picture's size stands in until the engine reports its own. */
  private fun adoptFrameSize(width: Int, height: Int) {
    Log.i(TAG, "frame resolution: ${width}x$height")
    if (surfaceWidth == 0 || surfaceHeight == 0) setSurfaceSize(width, height)
  }

  /** Called when props are (re)applied, so a late session still gets a renderer. */
  fun requestGeometryRefresh() {
    attachSink()
  }

  fun showKeyboard() {
    keyboard.requestFocus()
    inputMethods().showSoftInput(keyboard, InputMethodManager.SHOW_IMPLICIT)
  }

  fun hideKeyboard() {
    inputMethods().hideSoftInputFromWindow(keyboard.windowToken, 0)
  }

  fun captureKeyboard(captured: Boolean) {
    keyboardCaptured = captured
  }

  /** Show the whole desktop again. */
  fun fitToView() {
    fitted = true
    layoutPicture()
  }

  private fun inputMethods() = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager

  private fun attachSink() {
    val active = session ?: return
    active.frameSink = { track ->
      val target = renderer
      if (target != null && sinkAttached !== track) {
        sinkAttached?.removeSink(target)
        track.addSink(target)
        sinkAttached = track
        Log.i(TAG, "video sink attached; view=${width}x$height")
      }
    }
  }

  fun detachSink() {
    renderer?.let { sinkAttached?.removeSink(it) }
    sinkAttached = null
    session?.frameSink = null
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    // A rotation or the keyboard coming up: keep what the user was looking at.
    if (oldw > 0 && oldh > 0 && !fitted) {
      originX += (w - oldw) / 2f
      originY += (h - oldh) / 2f
    }
    layoutPicture()
  }

  // ---- Zoom and position -------------------------------------------------

  private fun fitScale(): Float {
    if (width == 0 || height == 0 || surfaceWidth == 0 || surfaceHeight == 0) return 1f
    return min(width.toFloat() / surfaceWidth, height.toFloat() / surfaceHeight)
  }

  /** Re-derive the placement from `fitted`, the zoom limits and the edges. */
  private fun layoutPicture() {
    if (surfaceWidth == 0 || surfaceHeight == 0 || width == 0 || height == 0) return
    val fit = fitScale()
    scale = if (fitted) fit else scale.coerceIn(fit, max(fit, MAX_SCALE))
    fitted = scale <= fit * 1.001f
    clampOrigin()
    publishTransform()
  }

  /** A picture smaller than the view is centred on that axis; a larger one covers it. */
  private fun clampOrigin() {
    val pictureWidth = surfaceWidth * scale
    val pictureHeight = surfaceHeight * scale
    originX = if (pictureWidth <= width) (width - pictureWidth) / 2f else originX.coerceIn(width - pictureWidth, 0f)
    originY = if (pictureHeight <= height) (height - pictureHeight) / 2f else originY.coerceIn(height - pictureHeight, 0f)
  }

  private fun zoomAround(focusX: Float, focusY: Float, factor: Float) {
    val fit = fitScale()
    val next = (scale * factor).coerceIn(fit, max(fit, MAX_SCALE))
    val applied = next / scale
    originX = focusX - (focusX - originX) * applied
    originY = focusY - (focusY - originY) * applied
    scale = next
    fitted = scale <= fit * 1.001f
    clampOrigin()
    publishTransform()
  }

  private fun panBy(dx: Float, dy: Float) {
    originX += dx
    originY += dy
    clampOrigin()
    publishTransform()
  }

  private fun publishTransform() {
    renderer?.setTransform(scale, originX, originY)
  }

  private fun dp(value: Float): Int = Math.round(value * resources.displayMetrics.density)

  /** A point in this view → desktop pixels, or null when it is off the picture. */
  private fun point(x: Float, y: Float): Pair<Int, Int>? {
    if (surfaceWidth == 0 || surfaceHeight == 0) return null
    val mappedX = Math.floor(((x - originX) / scale).toDouble()).toInt()
    val mappedY = Math.floor(((y - originY) / scale).toDouble()).toInt()
    if (mappedX < 0 || mappedY < 0 || mappedX >= surfaceWidth || mappedY >= surfaceHeight) return null
    return mappedX to mappedY
  }

  /** The same, held to the picture's edge: a drag may leave it and must still end somewhere. */
  private fun clampedPoint(x: Float, y: Float): Pair<Int, Int>? {
    if (surfaceWidth == 0 || surfaceHeight == 0) return null
    val mappedX = Math.floor(((x - originX) / scale).toDouble()).toInt().coerceIn(0, surfaceWidth - 1)
    val mappedY = Math.floor(((y - originY) / scale).toDouble()).toInt().coerceIn(0, surfaceHeight - 1)
    return mappedX to mappedY
  }

  // ---- Gestures ------------------------------------------------------------

  private fun cancelGesture() {
    removeCallbacks(longPress)
    gesture = Gesture.NONE
  }

  private fun handleTouch(event: MotionEvent): Boolean {
    val active = session ?: return true
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        gesture = Gesture.PENDING
        downX = event.x
        downY = event.y
        lastX = event.x
        lastY = event.y
        removeCallbacks(longPress)
        postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
      }

      MotionEvent.ACTION_POINTER_DOWN -> {
        removeCallbacks(longPress)
        when (gesture) {
          // A second finger ends a drag where the first one is.
          Gesture.DRAG -> endDrag(active, lastX, lastY)
          Gesture.PENDING, Gesture.PAN, Gesture.ARMED -> {}
          // A third finger is no gesture of ours; nothing it does is sent.
          Gesture.SCROLL -> {
            flushWheel(active, force = true)
            gesture = Gesture.SPENT
            return true
          }
          Gesture.TWO, Gesture.PINCH -> {
            gesture = Gesture.SPENT
            return true
          }
          else -> return true
        }
        if (event.pointerCount == 2) {
          gesture = Gesture.TWO
          twoStart = SystemClock.uptimeMillis()
          startSpan = span(event)
          lastSpan = startSpan
          startFocusX = focusX(event)
          startFocusY = focusY(event)
          lastFocusX = startFocusX
          lastFocusY = startFocusY
          wheelX = 0f
          wheelY = 0f
        } else {
          gesture = Gesture.SPENT
        }
      }

      MotionEvent.ACTION_MOVE -> when (gesture) {
        Gesture.PENDING -> if (hypot(event.x - downX, event.y - downY) > touchSlop) {
          removeCallbacks(longPress)
          gesture = Gesture.PAN
          lastX = event.x
          lastY = event.y
        }

        Gesture.PAN -> {
          panBy(event.x - lastX, event.y - lastY)
          lastX = event.x
          lastY = event.y
        }

        Gesture.ARMED -> if (hypot(event.x - downX, event.y - downY) > touchSlop) {
          val start = clampedPoint(downX, downY) ?: return true
          active.sendPointer("down", start.first, start.second)
          gesture = Gesture.DRAG
          dragTo(active, event.x, event.y)
        }

        Gesture.DRAG -> dragTo(active, event.x, event.y)

        Gesture.TWO, Gesture.PINCH, Gesture.SCROLL -> if (event.pointerCount >= 2) twoFingers(active, event)

        else -> {}
      }

      MotionEvent.ACTION_POINTER_UP -> {
        if (gesture == Gesture.TWO && SystemClock.uptimeMillis() - twoStart < ViewConfiguration.getDoubleTapTimeout()) {
          // Two fingers that landed and lifted without moving: a right click,
          // on the picture only — the letterbox is not the desktop's edge.
          point(startFocusX, startFocusY)?.let { (x, y) -> active.sendRightClick(x, y) }
        }
        if (gesture == Gesture.SCROLL) flushWheel(active, force = true)
        // What the remaining finger does next is not a new gesture.
        gesture = Gesture.SPENT
      }

      MotionEvent.ACTION_UP -> {
        removeCallbacks(longPress)
        when (gesture) {
          Gesture.PENDING -> tap(active, event.x, event.y)
          Gesture.ARMED -> point(downX, downY)?.let { (x, y) -> active.sendRightClick(x, y) }
          Gesture.DRAG -> endDrag(active, event.x, event.y)
          else -> {}
        }
        gesture = Gesture.NONE
      }

      MotionEvent.ACTION_CANCEL -> {
        removeCallbacks(longPress)
        if (gesture == Gesture.DRAG) active.sendCancel()
        gesture = Gesture.NONE
      }
    }
    return true
  }

  /**
   * A click where the finger landed. A second tap soon after and close by is
   * sent to the first tap's desktop point, so the desktop counts a double click
   * rather than two clicks a few pixels apart.
   */
  private fun tap(active: DesktopSession, x: Float, y: Float) {
    val now = SystemClock.uptimeMillis()
    val repeat = now - lastTapAt < ViewConfiguration.getDoubleTapTimeout() &&
      hypot(x - lastTapX, y - lastTapY) < doubleTapSlop
    val at = (if (repeat) lastTapPoint else null) ?: point(x, y) ?: return
    active.sendPointer("down", at.first, at.second)
    active.sendPointer("up", at.first, at.second)
    lastTapAt = now
    lastTapX = x
    lastTapY = y
    lastTapPoint = at
  }

  private fun dragTo(active: DesktopSession, x: Float, y: Float) {
    lastX = x
    lastY = y
    clampedPoint(x, y)?.let { (px, py) -> active.sendPointer("move", px, py, withButton = true) }
  }

  private fun endDrag(active: DesktopSession, x: Float, y: Float) {
    clampedPoint(x, y)?.let { (px, py) -> active.sendPointer("up", px, py) } ?: active.sendCancel()
  }

  private fun twoFingers(active: DesktopSession, event: MotionEvent) {
    val currentSpan = span(event)
    val fx = focusX(event)
    val fy = focusY(event)
    if (gesture == Gesture.TWO) {
      // Fingers that spread or close are zooming; fingers that travel together
      // are scrolling. Decide once, so a scroll never turns into a zoom halfway.
      if (abs(currentSpan - startSpan) > touchSlop * 2) {
        gesture = Gesture.PINCH
      } else if (hypot(fx - startFocusX, fy - startFocusY) > touchSlop) {
        gesture = Gesture.SCROLL
        // The desktop scrolls whatever is under its pointer.
        point(fx, fy)?.let { (x, y) -> active.sendPointer("move", x, y) }
      }
      lastSpan = currentSpan
      lastFocusX = fx
      lastFocusY = fy
      return
    }
    if (gesture == Gesture.PINCH) {
      if (lastSpan > 0f && currentSpan > 0f) zoomAround(fx, fy, currentSpan / lastSpan)
      panBy(fx - lastFocusX, fy - lastFocusY)
    } else {
      // Content follows the fingers: moving them up scrolls the page down.
      wheelX -= (fx - lastFocusX) / scale / PIXELS_PER_DETENT
      wheelY -= (fy - lastFocusY) / scale / PIXELS_PER_DETENT
      flushWheel(active, force = false)
    }
    lastSpan = currentSpan
    lastFocusX = fx
    lastFocusY = fy
  }

  private fun flushWheel(active: DesktopSession, force: Boolean) {
    if (!force && abs(wheelX) < MIN_WHEEL_STEP && abs(wheelY) < MIN_WHEEL_STEP) return
    if (wheelX == 0f && wheelY == 0f) return
    active.sendWheel(wheelX.coerceIn(-10f, 10f), wheelY.coerceIn(-10f, 10f))
    wheelX = 0f
    wheelY = 0f
  }

  private fun span(event: MotionEvent): Float =
    hypot(event.getX(0) - event.getX(1), event.getY(0) - event.getY(1))

  private fun focusX(event: MotionEvent): Float = (event.getX(0) + event.getX(1)) / 2f

  private fun focusY(event: MotionEvent): Float = (event.getY(0) + event.getY(1)) / 2f

  override fun onDetachedFromWindow() {
    // Unmounting must not leave a button held on the far desktop.
    removeCallbacks(longPress)
    runCatching { session?.sendCancel() }
    chordKeysDown.clear()
    detachSink()
    hideKeyboard()
    super.onDetachedFromWindow()
  }

  fun release() {
    setSession(null)
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
      // No automatic capitals: the desktop decides what a word is, and a shell
      // command that arrives as "Ls" is wrong.
      inputType = InputType.TYPE_CLASS_TEXT
      imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
      isSingleLine = true
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
      if (forwardModifierOrNamedKey(event)) return true
      if (forwardChord(event)) return true
      val character = event.unicodeChar
      if (character >= 32) {
        val text = String(Character.toChars(character))
        if (keyboardCaptured) session?.emitKeyboard(mapOf("text" to text)) else session?.sendText(text)
        return true
      }
      return super.onKeyDown(keyCode, event)
    }

    /** One tap of a named key: to the desktop, or to the app while it holds a modifier. */
    private fun tapKey(name: String) {
      if (keyboardCaptured) {
        session?.emitKeyboard(mapOf("key" to name))
        return
      }
      session?.sendKey(name, emptyList(), true)
      session?.sendKey(name, emptyList(), false)
    }

    /**
     * The keyboard typed while the app holds a sticky modifier.
     *
     * The word it was still composing was typed before the modifier and has not
     * gone yet, so it goes first, as text; only what the keyboard added to it is
     * the chord's. The keyboard then forgets the word and starts afresh, or it
     * would send the whole word again when it finishes it, chord key included.
     */
    private fun captureTyped(text: String) {
      val buffer = editableText
      val start = BaseInputConnection.getComposingSpanStart(buffer)
      val end = BaseInputConnection.getComposingSpanEnd(buffer)
      val pending = if (start in 0 until end) buffer.substring(start, end) else ""
      // A keyboard that rewrote its word (an autocorrection) is finishing it,
      // not adding a key.
      val extends = text.startsWith(pending)
      val plain = if (extends) pending else text
      val added = if (extends) text.substring(pending.length) else ""
      if (plain.isNotEmpty()) session?.sendText(plain)
      if (added.isNotEmpty()) session?.emitKeyboard(mapOf("text" to added))
      buffer.clear()
      post { inputMethods().restartInput(this) }
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
          if (keyboardCaptured && !text.isNullOrEmpty()) {
            captureTyped(text.toString())
            return true
          }
          if (!text.isNullOrEmpty()) session?.sendText(text.toString())
          return super.commitText(text, newCursorPosition)
        }

        override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
          // A chord is one key, not the start of a word: it goes as it is typed.
          if (keyboardCaptured && !text.isNullOrEmpty()) {
            captureTyped(text.toString())
            return true
          }
          return super.setComposingText(text, newCursorPosition)
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
          // Backspace and forward-delete are real keys, not edits to a local
          // buffer: the desktop owns the text.
          repeat(min(64, beforeLength)) { tapKey("Backspace") }
          repeat(min(64, afterLength)) { tapKey("Delete") }
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
            tapKey("Enter")
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
      // A plain key pressed while a sticky modifier waits is the app's to
      // chord. Only the press is held back: a release still goes, so a key
      // that was down before the capture cannot stick.
      if (keyboardCaptured && event.action == KeyEvent.ACTION_DOWN && event.hasNoModifiers() &&
        !KeyEvent.isModifierKey(event.keyCode)
      ) {
        tapKey(name)
        return true
      }
      session?.sendKey(name, heldModifiers(event), event.action == KeyEvent.ACTION_DOWN)
      return true
    }
  }

}
