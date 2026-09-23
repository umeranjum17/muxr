package expo.modules.desklink

import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.SurfaceHolder
import org.webrtc.EglBase
import org.webrtc.GlRectDrawer
import org.webrtc.GlShader
import org.webrtc.GlTextureFrameBuffer
import org.webrtc.GlUtil
import org.webrtc.ThreadUtils
import org.webrtc.VideoFrame
import org.webrtc.VideoFrameDrawer
import org.webrtc.VideoSink
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private const val TAG = "DesklinkRenderer"

private const val VERTEX_SHADER = """
attribute vec2 position;
attribute vec2 texCoord;
varying vec2 tc;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
  tc = texCoord;
}
"""

/**
 * Nine taps across the screen pixel's footprint when the picture is shown
 * smaller than its own size, one when it is shown at or above it. A 4K desktop
 * fitted to a phone is a 3–4x reduction, which a single bilinear tap aliases
 * into shimmering, broken text; averaging the footprint is what keeps it
 * legible. `highp` where the GPU has it, because a 4K texture needs more
 * precision than `mediump` gives a texture coordinate.
 */
private const val FRAGMENT_SHADER = """
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 tc;
uniform sampler2D picture;
uniform vec2 stepX;
uniform vec2 stepY;
void main() {
  vec4 sum = vec4(0.0);
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      sum += texture2D(picture, tc + float(i) * stepX + float(j) * stepY);
    }
  }
  gl_FragColor = sum / 9.0;
}
"""

/**
 * Draws the desktop into a surface at any zoom and position.
 *
 * Each decoded frame is copied once into a texture this renderer owns, and the
 * decoder's buffer is released at once: the decoder has only a few output
 * buffers, and a renderer that held one to redraw it would stall the stream.
 * The copy is what a pinch or a pan redraws, instantly and without waiting for
 * the desktop to change.
 *
 * All GL work runs on one render thread, and only while the view has a
 * surface: frames that arrive without one are dropped, and the stream's next
 * frame follows within a second. The transform is set from the UI thread and
 * read here; nothing is drawn until the view has placed the picture.
 */
internal class DesktopRenderer(
  private val shared: EglBase.Context,
  private val onFirstFrame: () -> Unit,
  private val onFrameSize: (width: Int, height: Int) -> Unit,
) : VideoSink, SurfaceHolder.Callback {
  private val thread = HandlerThread("desklink-render").apply { start() }
  private val handler = Handler(thread.looper)
  private val pending = AtomicReference<VideoFrame?>(null)
  private val drawQueued = AtomicBoolean(false)
  private val released = AtomicBoolean(false)

  // Render thread only.
  private var egl: EglBase? = null
  private var windowSurface = false
  private var picture: GlTextureFrameBuffer? = null
  private var frameDrawer: VideoFrameDrawer? = null
  private var copyDrawer: GlRectDrawer? = null
  private var shader: GlShader? = null
  private var presented = false

  // Surface pixels per picture pixel, and where the picture's top-left sits on
  // the surface; null until the view has placed it. Written by the UI thread.
  @Volatile private var transform: FloatArray? = null

  init {
    handler.post { context() }
  }

  /** The render thread's GL context, created on first use. */
  private fun context(): EglBase? {
    egl?.let { return it }
    return runCatching {
      EglBase.create(shared, EglBase.CONFIG_PLAIN).also {
        egl = it
        frameDrawer = VideoFrameDrawer()
        copyDrawer = GlRectDrawer()
      }
    }.onFailure { Log.w(TAG, "no GL context for the desktop picture", it) }.getOrNull()
  }

  /** Where the picture goes, in surface pixels; redraws what is already there. */
  fun setTransform(scale: Float, originX: Float, originY: Float) {
    transform = floatArrayOf(scale, originX, originY)
    requestDraw()
  }

  override fun onFrame(frame: VideoFrame) {
    if (released.get()) return
    frame.retain()
    pending.getAndSet(frame)?.release()
    handler.post { copyPending() }
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    ThreadUtils.invokeAtFrontUninterruptibly(handler) {
      val base = context() ?: return@invokeAtFrontUninterruptibly
      runCatching {
        base.createSurface(holder.surface)
        base.makeCurrent()
        windowSurface = true
      }.onFailure { Log.w(TAG, "could not draw into the view's surface", it) }
    }
    requestDraw()
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    requestDraw()
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    // The surface is gone when this returns, so the render thread must have
    // let go of it first.
    ThreadUtils.invokeAtFrontUninterruptibly(handler) {
      val base = egl ?: return@invokeAtFrontUninterruptibly
      if (!windowSurface) return@invokeAtFrontUninterruptibly
      windowSurface = false
      // The context, and the picture copied into it, outlive the surface.
      runCatching { base.detachCurrent() }
      base.releaseSurface()
    }
  }

  fun release() {
    if (!released.compareAndSet(false, true)) return
    handler.post {
      pending.getAndSet(null)?.release()
      // GL objects die with their context; releasing them first is only tidy.
      runCatching {
        picture?.release()
        shader?.release()
        copyDrawer?.release()
        frameDrawer?.release()
      }
      runCatching { egl?.release() }
      picture = null
      shader = null
      copyDrawer = null
      frameDrawer = null
      egl = null
      thread.quitSafely()
    }
  }

  private fun requestDraw() {
    if (released.get()) return
    if (drawQueued.compareAndSet(false, true)) {
      handler.post {
        drawQueued.set(false)
        draw()
      }
    }
  }

  private fun copyPending() {
    val frame = pending.getAndSet(null) ?: return
    try {
      if (!windowSurface) return
      val drawer = frameDrawer ?: return
      val rect = copyDrawer ?: return
      val width = frame.rotatedWidth
      val height = frame.rotatedHeight
      val target = picture ?: GlTextureFrameBuffer(GLES20.GL_RGBA).also { picture = it }
      if (target.width != width || target.height != height) {
        target.setSize(width, height)
        onFrameSize(width, height)
      }
      GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, target.frameBufferId)
      drawer.drawFrame(frame, rect, null, 0, 0, width, height)
      GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    } catch (error: RuntimeException) {
      Log.w(TAG, "could not copy a frame", error)
      return
    } finally {
      frame.release()
    }
    draw()
  }

  private fun draw() {
    try {
      drawPicture()
    } catch (error: RuntimeException) {
      // A GL failure costs this frame, not the app.
      Log.w(TAG, "could not draw the desktop", error)
    }
  }

  private fun drawPicture() {
    val base = egl ?: return
    val source = picture ?: return
    val (scale, originX, originY) = transform ?: return
    if (!windowSurface || source.width == 0) return
    val width = base.surfaceWidth()
    val height = base.surfaceHeight()
    if (width <= 0 || height <= 0) return
    val program = shader ?: GlShader(VERTEX_SHADER, FRAGMENT_SHADER).also { shader = it }
    val left = originX / width * 2f - 1f
    val right = (originX + source.width * scale) / width * 2f - 1f
    val top = 1f - originY / height * 2f
    val bottom = 1f - (originY + source.height * scale) / height * 2f

    // One screen pixel covers 1/scale picture pixels; spread the taps over it.
    val footprint = 1f / scale
    val spread = if (footprint > 1f) footprint / 3f else 0f

    GLES20.glViewport(0, 0, width, height)
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    program.useProgram()
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, source.textureId)
    GLES20.glUniform1i(program.getUniformLocation("picture"), 0)
    GLES20.glUniform2f(program.getUniformLocation("stepX"), spread / source.width, 0f)
    GLES20.glUniform2f(program.getUniformLocation("stepY"), 0f, spread / source.height)
    program.setVertexAttribArray("position", 2, GlUtil.createFloatBuffer(floatArrayOf(
      left, bottom, right, bottom, left, top, right, top,
    )))
    // The copy holds the picture upright in GL's bottom-up rows.
    program.setVertexAttribArray("texCoord", 2, GlUtil.createFloatBuffer(floatArrayOf(
      0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f,
    )))
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)
    base.swapBuffers()

    if (!presented) {
      presented = true
      onFirstFrame()
    }
  }
}
