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
use std::sync::atomic::{AtomicU64, Ordering};
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
    quit: pw::channel::Sender<()>,
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
        // The channel queues a stop even before the loop starts, and remains
        // safe if setup already failed. A shared raw loop pointer does neither.
        let _ = self.quit.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
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
            Rectangle {
                width: 2560,
                height: 1440
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: 7680,
                height: 4320
            }
        ),
        property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: 30, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction {
                num: 1000,
                denom: 1
            }
        ),
    );
    PodSerializer::serialize(Cursor::new(buffer), &Value::Object(obj))
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("failed to build EnumFormat pod: {e}"))
}

/// Ask for CPU-mappable buffers first. A compositor that only produces
/// DMA-BUFs will ignore the choice and we report that instead of reading garbage.
fn buffer_pod(buffer: &mut Vec<u8>) -> Result<()> {
    use spa::pod::ChoiceValue;
    use spa::pod::{object, property, Value};
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
    let (quit, stop) = pw::channel::channel();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let node_id = source.node_id;
    let thread = {
        let geometry = geometry.clone();
        let frames = frames.clone();
        let dropped = dropped.clone();
        let ready = ready_tx;
        std::thread::Builder::new()
            .name("desklink-capture".into())
            .spawn(move || {
                let result = run_loop(
                    fd,
                    node_id,
                    encoded_width,
                    encoded_height,
                    sink,
                    geometry,
                    frames,
                    dropped,
                    stop,
                    ready.clone(),
                );
                // Only a delivered frame means ready. A loop that ended without
                // one must not turn an early exit into a successful start.
                let error = result
                    .err()
                    .map(|e| format!("{e:#}"))
                    .unwrap_or_else(|| String::from("capture ended before its first frame"));
                let _ = ready.send(Err(error));
            })
            .context("failed to spawn capture thread")?
    };

    // Own cleanup before waiting: timeout, setup failure and panic all stop and
    // join the worker, not just a successfully returned Capture.
    let capture = Capture {
        quit,
        thread: Some(thread),
        source,
        geometry,
        frames,
        dropped,
        encoded_width,
        encoded_height,
    };
    match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(capture),
        Ok(Err(e)) => anyhow::bail!("capture failed: {e}"),
        Err(mpsc::RecvTimeoutError::Timeout) => anyhow::bail!("capture did not start within 10s"),
        Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("capture thread died"),
    }
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
    stop: pw::channel::Receiver<()>,
    ready: mpsc::Sender<Result<(), String>>,
) -> Result<()> {
    pw::init();
    let main_loop = pw::main_loop::MainLoopRc::new(None).context("pw_main_loop_new failed")?;
    let _stop = stop.attach(main_loop.loop_(), {
        let main_loop = main_loop.clone();
        move |_| main_loop.quit()
    });

    let context =
        pw::context::ContextBox::new(main_loop.loop_(), None).context("pw_context_new failed")?;
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

    let mut ready = Some(ready);
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
        .process(move |stream, state| {
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
            let offset = chunk.offset() as usize;
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
            let Some(chunk_bytes) = bytes.get(offset..offset.saturating_add(size)) else {
                state.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            };
            // Exactly the encoder's size: fitting again here would round a
            // second time and hand the encoder a frame it refuses whenever the
            // stream's size differs from the one the portal reported.
            let seq = state.frames.load(Ordering::Relaxed);
            match to_i420(chunk_bytes, w, h, stride, format, state.box_w, state.box_h) {
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
                    // The first frame the loop actually delivers is the only
                    // proof capture started; sending this when `run_loop`
                    // returns would be after the main loop quits, too late for
                    // `start` to wait on.
                    if let Some(sender) = ready.take() {
                        let _ = sender.send(Ok(()));
                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn dropping_capture_stops_and_joins_its_live_pipewire_loop() {
        // Exercise the real event-loop/channel lifetime without a portal,
        // compositor, screen capture or input device.
        let (quit, stop) = pw::channel::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (ended_tx, ended_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            pw::init();
            let main_loop = pw::main_loop::MainLoopRc::new(None).unwrap();
            let _stop = stop.attach(main_loop.loop_(), {
                let main_loop = main_loop.clone();
                move |_| main_loop.quit()
            });
            let timer = main_loop.loop_().add_timer(move |_| {
                let _ = ready_tx.send(());
            });
            timer
                .update_timer(Some(Duration::from_millis(1)), None)
                .into_result()
                .unwrap();
            main_loop.run();
        });
        let capture = Capture {
            quit,
            thread: Some(thread),
            source: SelectedSource {
                node_id: 0,
                width: 2,
                height: 2,
                position: None,
                source_type: None,
                origin_x: 0,
                origin_y: 0,
            },
            geometry: Arc::new(Mutex::new(None)),
            frames: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            encoded_width: 2,
            encoded_height: 2,
        };
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the loop is running");
        // Keep a broken join bounded so a missing stop is a failed check rather
        // than a test process that hangs forever.
        std::thread::spawn(move || {
            drop(capture);
            ended_tx.send(()).unwrap();
        });
        ended_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("capture stopped and joined");
    }
}
