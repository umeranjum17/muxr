//! PipeWire capture of the portal's screen cast node.
//!
//! The portal hands us a PipeWire remote fd and a node id. We connect that
//! remote, ask the node for a format we can read on the CPU, and pull frames.
//! Everything PipeWire lives on this module's own thread because its objects are
//! not `Send`; frames and state changes leave through channels.

use crate::convert::{to_i420, I420};
use crate::portal::{PortalSession, SelectedSource};
use anyhow::{Context, Result};
use pipewire as pw;
use pw::spa;
use pw::spa::pod::{serialize::PodSerializer, Pod};
use std::io::Cursor;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PixelFormat {
    Bgrx,
    Rgbx,
    Bgra,
    Rgba,
    Bgr,
    Rgb,
    Unsupported,
}

impl PixelFormat {
    fn from_spa(raw: u32) -> Self {
        match raw {
            v if v == spa::param::video::VideoFormat::BGRx.as_raw() => Self::Bgrx,
            v if v == spa::param::video::VideoFormat::RGBx.as_raw() => Self::Rgbx,
            v if v == spa::param::video::VideoFormat::BGRA.as_raw() => Self::Bgra,
            v if v == spa::param::video::VideoFormat::RGBA.as_raw() => Self::Rgba,
            v if v == spa::param::video::VideoFormat::BGR.as_raw() => Self::Bgr,
            v if v == spa::param::video::VideoFormat::RGB.as_raw() => Self::Rgb,
            _ => Self::Unsupported,
        }
    }
}

/// Everything we learned about the negotiated stream, reported to the consumer
/// so it can map input against the real surface.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StreamGeometry {
    pub source_width: usize,
    pub source_height: usize,
    pub origin_x: i32,
    pub origin_y: i32,
    pub format: String,
    pub buffer_type: String,
}

pub type FrameSink = Box<dyn Fn(I420, u64) + Send + 'static>;

/// A running capture. Dropping it quits the PipeWire loop and joins its thread.
pub struct Capture {
    quit: Arc<AtomicUsize>,
    thread: Option<JoinHandle<()>>,
    pub source: SelectedSource,
    geometry: Arc<Mutex<Option<StreamGeometry>>>,
    frames: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    pub encoded_width: usize,
    pub encoded_height: usize,
}

impl Capture {
    pub fn geometry(&self) -> Option<StreamGeometry> {
        self.geometry.lock().ok().and_then(|g| g.clone())
    }

    pub fn frame_count(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let ptr = self.quit.swap(0, Ordering::SeqCst);
        if ptr != 0 {
            // SAFETY: `ptr` is the `pw_main_loop` created by, and still owned by,
            // the capture thread. `pw_main_loop_quit` is explicitly thread-safe
            // (it signals the loop's eventfd) and the thread is joined below
            // before the loop is destroyed, so the pointer cannot dangle here.
            unsafe { pw::sys::pw_main_loop_quit(ptr as *mut pw::sys::pw_main_loop) };
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A raw `spa_format`/parameter key, so `property!` can take the `spa_sys`
/// constants that have no `as_raw()` of their own.
struct RawKey(u32);

impl RawKey {
    fn as_raw(&self) -> u32 {
        self.0
    }
}

/// Build the `EnumFormat` we can consume: packed 4-byte colour, at whatever
/// size the compositor picked.
///
/// Deliberately carries **no** `modifier` property. A compositor's screen cast
/// node reads that as "the client wants a DMA-BUF" and hands back a buffer this
/// process could not read without a GPU download step; without it the same node
/// produces a CPU-mappable shared-memory buffer.
fn format_pod(buffer: &mut Vec<u8>) -> Result<()> {
    use spa::param::format::{FormatProperties, MediaSubtype, MediaType};
    use spa::param::video::VideoFormat;
    use spa::pod::{object, property, Value};
    use spa::utils::{Fraction, Rectangle, SpaTypes};

    let obj = object!(
        SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        property!(FormatProperties::MediaType, Id, MediaType::Video),
        property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA
        ),
        property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle { width: 2560, height: 1440 },
            Rectangle { width: 1, height: 1 },
            Rectangle { width: 7680, height: 4320 }
        ),
        property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: 30, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction { num: 1000, denom: 1 }
        ),
    );
    PodSerializer::serialize(Cursor::new(buffer), &Value::Object(obj))
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("failed to build EnumFormat pod: {e}"))
}

/// Ask for CPU-mappable buffers first. A compositor that only produces
/// DMA-BUFs will ignore the choice and we report that instead of reading garbage.
fn buffer_pod(buffer: &mut Vec<u8>) -> Result<()> {
    use spa::pod::{object, property, Value};
    use spa::pod::ChoiceValue;
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, SpaTypes};
    let obj = object!(
        SpaTypes::ObjectParamBuffers,
        spa::param::ParamType::Buffers,
        property!(
            RawKey(spa::sys::SPA_PARAM_BUFFERS_dataType),
            Value::Choice(ChoiceValue::Int(Choice(
                ChoiceFlags::empty(),
                ChoiceEnum::Flags {
                    default: (1 << spa::buffer::DataType::MemFd.as_raw()) as i32,
                    flags: vec![
                        (1 << spa::buffer::DataType::MemFd.as_raw()) as i32,
                        (1 << spa::buffer::DataType::DmaBuf.as_raw()) as i32,
                    ],
                }
            )))
        ),
    );
    PodSerializer::serialize(Cursor::new(buffer), &Value::Object(obj))
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("failed to build Buffers pod: {e}"))
}

/// Start capturing `session`'s node, delivering I420 frames to `sink`.
pub fn start(
    session: PortalSession,
    encoded_width: usize,
    encoded_height: usize,
    sink: FrameSink,
) -> Result<Capture> {
    let PortalSession { fd, source, .. } = session;
    let geometry = Arc::new(Mutex::new(None));
    let frames = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let quit = Arc::new(AtomicUsize::new(0));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let node_id = source.node_id;
    let thread = {
        let geometry = geometry.clone();
        let frames = frames.clone();
        let dropped = dropped.clone();
        let quit = quit.clone();
        std::thread::Builder::new()
            .name("desklink-capture".into())
            .spawn(move || {
                let result = run_loop(fd, node_id, encoded_width, encoded_height, sink, geometry, frames, dropped, quit.clone())
                    .map_err(|e| format!("{e:#}"));
                let _ = ready_tx.send(result);
            })
            .context("failed to spawn capture thread")?
    };

    // Surface a capture start failure instead of returning a silently dead handle.
    match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => anyhow::bail!("capture failed: {e}"),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            anyhow::bail!("capture did not start within 10s")
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("capture thread died"),
    }

    Ok(Capture {
        quit,
        thread: Some(thread),
        source,
        geometry,
        frames,
        dropped,
        encoded_width,
        encoded_height,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_loop(
    fd: OwnedFd,
    node_id: u32,
    encoded_width: usize,
    encoded_height: usize,
    sink: FrameSink,
    geometry: Arc<Mutex<Option<StreamGeometry>>>,
    frames: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    quit: Arc<AtomicUsize>,
) -> Result<()> {
    pw::init();
    let main_loop =
        pw::main_loop::MainLoopBox::new(None).context("pw_main_loop_new failed")?;
    quit.store(main_loop.as_raw_ptr() as usize, Ordering::SeqCst);

    let context = pw::context::ContextBox::new(main_loop.loop_(), None)
        .context("pw_context_new failed")?;
    let core = context
        .connect_fd(fd, None)
        .context("pw_context_connect_fd failed")?;

    let mut props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Video",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Screen",
    };
    props.insert(*pw::keys::TARGET_OBJECT, node_id.to_string());
    let stream = pw::stream::StreamBox::new(&core, "desklink-capture", props)
        .context("pw_stream_new failed")?;

    let mut state = StreamState {
        box_w: encoded_width,
        box_h: encoded_height,
        format: None,
        buffer_type: String::from("unknown"),
        sink,
        geometry,
        frames,
        dropped,
        logical_w: 0,
        logical_h: 0,
    };

    let _listener = stream
        .add_local_listener_with_user_data(&mut state)
        .param_changed(|_, state, id, param| {
            if id != pw::spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Some(param) = param else { return };
            // SAFETY: PipeWire guarantees `param` is a valid spa_pod for the
            // duration of this callback; `Pod` is a transparent wrapper over it.
            let pod = param;
            if let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(pod) {
                if media_type != spa::param::format::MediaType::Video
                    || media_subtype != spa::param::format::MediaSubtype::Raw
                {
                    return;
                }
            }
            let mut info = spa::param::video::VideoInfoRaw::new();
            if info.parse(pod).is_err() {
                return;
            }
            state.format = Some(PixelFormat::from_spa(info.format().as_raw()));
            state.logical_w = info.size().width as usize;
            state.logical_h = info.size().height as usize;
        })
        .process(|stream, state| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let Some(format) = state.format else { return };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let data = &mut datas[0];
            let kind = data.type_();
            let chunk = data.chunk();
            let stride = chunk.stride().max(0) as usize;
            let size = chunk.size() as usize;
            state.buffer_type = format!("{kind:?}");
            let (w, h) = (state.logical_w, state.logical_h);
            if w == 0 || h == 0 {
                return;
            }
            let Some(bytes) = data.data() else {
                // Not a CPU-mappable buffer (a DMA-BUF the compositor refused to
                // convert). Count it and stay honest; the consumer reads
                // `buffer_type` to report an unsupported source.
                state.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            };
            let stride = if stride == 0 { w * 4 } else { stride };
            let used = if size == 0 { bytes.len() } else { size.min(bytes.len()) };
            let (dw, dh) = encoded_dims(w, h, state.box_w, state.box_h);
            let seq = state.frames.load(Ordering::Relaxed);
            match to_i420(&bytes[..used], w, h, stride, format, dw, dh) {
                Some(i420) => {
                    if state.geometry.lock().map(|g| g.is_none()).unwrap_or(false) {
                        if let Ok(mut g) = state.geometry.lock() {
                            *g = Some(StreamGeometry {
                                source_width: w,
                                source_height: h,
                                origin_x: 0,
                                origin_y: 0,
                                format: format!("{format:?}").to_lowercase(),
                                buffer_type: state.buffer_type.clone(),
                            });
                        }
                    }
                    state.frames.fetch_add(1, Ordering::Relaxed);
                    (state.sink)(i420, seq);
                }
                None => {
                    state.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        })
        .register()
        .context("pw_stream_add_listener failed")?;

    let mut format_buf = Vec::new();
    format_pod(&mut format_buf)?;
    let mut buffer_buf = Vec::new();
    buffer_pod(&mut buffer_buf)?;
    let mut params = [
        Pod::from_bytes(&format_buf).context("invalid EnumFormat pod")?,
        Pod::from_bytes(&buffer_buf).context("invalid Buffers pod")?,
    ];

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .context("pw_stream_connect failed")?;

    main_loop.run();
    Ok(())
}

/// Fit the source into the requested encoded box, never upscaling and keeping
/// even dimensions because I420 chroma is subsampled.
fn encoded_dims(w: usize, h: usize, max_w: usize, max_h: usize) -> (usize, usize) {
    if max_w == 0 || max_h == 0 || (w <= max_w && h <= max_h) {
        return (w & !1, h & !1);
    }
    let scale = f64::min(max_w as f64 / w as f64, max_h as f64 / h as f64);
    let dw = ((w as f64 * scale) as usize) & !1;
    let dh = ((h as f64 * scale) as usize) & !1;
    (dw.max(2), dh.max(2))
}

struct StreamState {
    box_w: usize,
    box_h: usize,
    format: Option<PixelFormat>,
    buffer_type: String,
    sink: FrameSink,
    geometry: Arc<Mutex<Option<StreamGeometry>>>,
    frames: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    logical_w: usize,
    logical_h: usize,
}

// PipeWire callbacks only touch this from the capture thread.
unsafe impl Send for StreamState {}
