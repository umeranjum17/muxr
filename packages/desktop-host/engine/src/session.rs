//! One authorized desktop session: capture in, VP9 out, control channel in,
//! desktop input out, and a bounded teardown.
//!
//! The engine trusts the consumer's local permission decision and enforces the
//! resulting scope. It has no second identity system, no account and no notion
//! of which application asked.

use crate::capture::{self, Capture};
use crate::clipboard;
use crate::convert::{fit, I420};
use crate::encoder::Encoder;
use crate::input::{Button, HeldState, InputDevices};
use crate::keymap::{self, Layout};
use crate::peer::{PeerEvent, TransportOptions, VideoPeer};
use crate::portal::{self, SelectedSource};
use crate::protocol::{ControlMessage, ControlReply, Permission, PointerPhase, SourceRequest};
use crate::x11::X11Desktop;
use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc as tokio_mpsc;

/// How long a clipboard operation may take before it is reported as unanswered.
///
/// A compositor with no clipboard service must produce an error the user can
/// read, not a request that never returns.
const CLIPBOARD_TIMEOUT: Duration = Duration::from_secs(3);

/// Run a clipboard operation off the async runtime and bounded.
///
/// Both halves matter. The clipboard backends block, and running one inline on
/// a runtime thread stalls the session's own input and lifecycle events; and a
/// desktop whose clipboard cannot answer must fail visibly rather than hang.
async fn clipboard_task<T: Send + 'static>(
    operation: impl FnOnce() -> std::result::Result<T, String> + Send + 'static,
) -> std::result::Result<T, String> {
    match tokio::time::timeout(CLIPBOARD_TIMEOUT, tokio::task::spawn_blocking(operation)).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(format!("the clipboard operation failed: {join}")),
        Err(_) => Err(String::from("the desktop clipboard did not answer")),
    }
}

/// How the capture → encode → send path is doing, reported to the consumer.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Metrics {
    pub captured_frames: u64,
    pub dropped_frames: u64,
    pub encoded_frames: u64,
    pub encoded_bytes: u64,
    /// Key frames sent: the first, and one per receiver request.
    pub key_frames: u64,
    /// Refinement passes: a still desktop re-coded once, sharp.
    pub refined_frames: u64,
    /// Time spent in the encoder, in microseconds, over every encoded frame.
    pub encode_micros: u64,
    /// The current rate target, after any loss back-off.
    pub target_kbps: u32,
    pub input_applied: u64,
    pub input_rejected: u64,
}

/// Which desktop is being captured.
///
/// Dropping either variant stops its capture: the portal variant drops the
/// PipeWire stream, which is what releases the compositor's consent, and the X11
/// variant stops reading the server.
enum FrameSource {
    Portal(Capture),
    X11(X11Capture),
}

/// Root-window capture on an X display this engine was pointed at.
struct X11Capture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for X11Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What a chosen capture backend gives the session.
struct Selected {
    source: SelectedSource,
    capture: FrameSource,
    /// Present only on the X11 path, where the same connection applies input.
    x11: Option<Arc<Mutex<X11Desktop>>>,
}

/// Open an X display, start reading its root window, and hand back the same
/// shape the portal path produces.
fn select_x11(
    display: Option<&str>,
    max_width: usize,
    max_height: usize,
    max_fps: u32,
    metrics: Arc<Mutex<Metrics>>,
    sink: capture::FrameSink,
) -> Result<Selected> {
    let desktop = Arc::new(Mutex::new(X11Desktop::connect(display)?));
    let (width, height) = {
        let desktop = lock(&desktop);
        desktop.screen_size()
    };
    let source = SelectedSource {
        node_id: 0,
        width,
        height,
        position: Some((0, 0)),
        source_type: Some(String::from("x11-root")),
        origin_x: 0,
        origin_y: 0,
    };

    let stop = Arc::new(AtomicBool::new(false));
    let captured = metrics.clone();
    let thread = {
        let desktop = desktop.clone();
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("desklink-x11-capture".into())
            .spawn(move || {
                let interval = frame_interval(max_fps);
                let mut sequence = 0u64;
                // An X server has no damage signal here, so an unchanged screen
                // is recognised by its pixels: handing it on would keep the
                // encoder busy and a still desktop would never be refined.
                let mut last_hash = None;
                while !stop.load(Ordering::SeqCst) {
                    let started = Instant::now();
                    let frame = {
                        let mut desktop = lock(&desktop);
                        desktop.capture(max_width, max_height)
                    };
                    match frame {
                        Ok(frame) => {
                            use std::hash::{Hash, Hasher};
                            let mut hasher = std::collections::hash_map::DefaultHasher::new();
                            frame.data.hash(&mut hasher);
                            let hash = hasher.finish();
                            if last_hash != Some(hash) {
                                last_hash = Some(hash);
                                sink(frame, sequence);
                                sequence += 1;
                            }
                        }
                        Err(error) => {
                            if let Ok(mut m) = captured.lock() {
                                m.dropped_frames += 1;
                            }
                            // A display that has gone away is not recoverable by
                            // retrying, so stop rather than spin on the error.
                            if error
                                .to_string()
                                .contains("the X11 connection dropped")
                            {
                                break;
                            }
                        }
                    }
                    let elapsed = started.elapsed();
                    if elapsed < interval {
                        std::thread::sleep(interval - elapsed);
                    }
                }
            })
            .ok()
    };

    Ok(Selected {
        source,
        capture: FrameSource::X11(X11Capture { stop, thread }),
        x11: Some(desktop),
    })
}

/// Where input goes. One controller, one applier, one held-state record.
struct InputTarget {
    applier: Applier,
    held: HeldState,
    /// Fractions of a detent an X server, which only knows whole wheel clicks,
    /// has not been sent yet.
    wheel_rest: (f64, f64),
}

enum Applier {
    Uinput(InputDevices),
    X11(Arc<Mutex<X11Desktop>>),
    #[cfg(test)]
    Recording(Arc<Mutex<Vec<(i16, bool)>>>),
}

impl InputTarget {
    fn move_absolute(&mut self, x: i64, y: i64) -> Result<()> {
        match &mut self.applier {
            Applier::Uinput(devices) => {
                devices.move_absolute(x, y);
                Ok(())
            }
            Applier::X11(desktop) => lock(desktop).move_pointer(x, y),
            #[cfg(test)]
            Applier::Recording(_) => Ok(()),
        }
    }

    fn button(&mut self, button: Button, down: bool) -> Result<()> {
        self.held.button(button, down);
        match &mut self.applier {
            Applier::Uinput(devices) => {
                devices.button(button, down);
                Ok(())
            }
            Applier::X11(desktop) => lock(desktop).button(x11_button(button), down),
            #[cfg(test)]
            Applier::Recording(log) => {
                if let Ok(mut log) = log.lock() {
                    log.push((-1, down));
                }
                Ok(())
            }
        }
    }

    fn scroll(&mut self, dx: f64, dy: f64) -> Result<()> {
        match &mut self.applier {
            Applier::Uinput(devices) => {
                devices.scroll(dx, dy);
                Ok(())
            }
            Applier::X11(desktop) => {
                let (rest_x, rest_y) = (self.wheel_rest.0 + dx, self.wheel_rest.1 + dy);
                let (whole_x, whole_y) = (rest_x.trunc(), rest_y.trunc());
                self.wheel_rest = (rest_x - whole_x, rest_y - whole_y);
                lock(desktop).scroll(whole_x as i64, whole_y as i64)
            }
            #[cfg(test)]
            Applier::Recording(_) => Ok(()),
        }
    }

    fn check_keys(&self, codes: impl IntoIterator<Item = i16>) -> Result<()> {
        if matches!(&self.applier, Applier::Uinput(_)) {
            for code in codes {
                crate::input::native_keycode(code)?;
            }
        }
        Ok(())
    }

    fn key(&mut self, code: i16, down: bool) -> Result<()> {
        match &mut self.applier {
            Applier::Uinput(devices) => devices.key(code, down),
            Applier::X11(desktop) => lock(desktop).key(code, down),
            #[cfg(test)]
            Applier::Recording(log) => {
                if let Ok(mut log) = log.lock() {
                    log.push((code, down));
                }
                Ok(())
            }
        }?;
        self.held.key(code, down);
        Ok(())
    }

    /// Release exactly what this session pressed, once, buttons before keys.
    fn release_all(&mut self) -> Result<()> {
        let (buttons, keys) = self.held.release_plan();
        for button in buttons {
            match &mut self.applier {
                Applier::Uinput(devices) => devices.button(button, false),
                Applier::X11(desktop) => lock(desktop).button(x11_button(button), false)?,
                #[cfg(test)]
                Applier::Recording(log) => {
                    if let Ok(mut log) = log.lock() {
                        log.push((-1, false));
                    }
                }
            }
        }
        for code in keys {
            match &mut self.applier {
                Applier::Uinput(devices) => devices.key(code, false)?,
                Applier::X11(desktop) => lock(desktop).key(code, false)?,
                #[cfg(test)]
                Applier::Recording(log) => {
                    if let Ok(mut log) = log.lock() {
                        log.push((code, false));
                    }
                }
            }
        }
        Ok(())
    }
}

fn x11_button(button: Button) -> u8 {
    match button {
        Button::Left => crate::x11::button::LEFT,
        Button::Middle => crate::x11::button::MIDDLE,
        Button::Right => crate::x11::button::RIGHT,
    }
}

fn lock<T>(mutex: &Arc<Mutex<T>>) -> std::sync::MutexGuard<'_, T> {
    // A poisoned lock means a previous input call panicked while applying; the
    // desktop is then in unknown state, so the session is closed rather than
    // continuing to drive it.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why a session could not do what was asked, in the protocol's own vocabulary.
pub struct SessionError {
    pub code: &'static str,
    pub message: String,
}

impl SessionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct OpenRequest {
    /** Which desktop to capture; absent means the portal. */
    pub source: Option<SourceRequest>,
    pub permissions: Vec<Permission>,
    pub max_width: usize,
    pub max_height: usize,
    pub bitrate_kbps: u32,
    pub max_fps: u32,
    pub ice_servers: Vec<(String, Option<String>, Option<String>)>,
    pub relay_only: bool,
    pub restore_token: Option<String>,
    pub ttl: Option<Duration>,
}

/// Events a session raises for its consumer.
#[derive(Debug)]
pub enum SessionEvent {
    Description { generation: u64, sdp: String },
    Candidate {
        generation: u64,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    },
    State {
        capture: &'static str,
        transport: String,
        first_frame: bool,
    },
    RestoreToken(String),
    Revoked { reason: String },
}

/// One notification plus the session it belongs to. The engine serves one
/// session at a time, but its queue outlives a session, so a consumer needs the
/// identity to attribute an event to the record that asked for it.
#[derive(Debug)]
pub struct Notice {
    pub session_id: String,
    pub event: SessionEvent,
}

/// Everything a session's background tasks need, shared rather than borrowed so
/// the consumer can own the `Session` handle while the pipeline runs.
struct Inner {
    id: String,
    generation: u64,
    permissions: Vec<Permission>,
    source: SelectedSource,
    geometry: serde_json::Value,
    metrics: Arc<Mutex<Metrics>>,
    peer: Arc<VideoPeer>,
    encoder: Mutex<Encoder>,
    input: Mutex<Option<InputTarget>>,
    capture: Mutex<Option<FrameSource>>,
    layout: Mutex<Layout>,
    last_seq: Mutex<u64>,
    control_open: AtomicBool,
    closed: AtomicBool,
    /// Set false to stop the encode loop; owned here so closing is reachable
    /// from the lease as well as from the consumer.
    pipeline: Arc<AtomicBool>,
    events: tokio_mpsc::UnboundedSender<Notice>,
}

pub struct Session {
    inner: Arc<Inner>,
}

/// What the engine can actually do on this machine right now.
pub fn capabilities() -> serde_json::Value {
    let session_kind = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        "wayland"
    } else if std::env::var_os("DISPLAY").is_some() {
        "x11"
    } else {
        "none"
    };
    // Clipboard transfer needs Wayland; writes also need a selection server
    // that can outlive this engine. Do not offer it when that tool is absent.
    let clipboard = session_kind == "wayland";
    let x11 = crate::x11::X11Desktop::connect(None)
        .map(|desktop| serde_json::json!([desktop.screen_size().0, desktop.screen_size().1]))
        .unwrap_or(serde_json::Value::Null);
    let (input, grant_state, unavailable) = match crate::input::probe() {
        Ok(()) => (serde_json::json!(true), "granted", serde_json::Value::Null),
        Err(unavailable) => (
            serde_json::json!(false),
            "missing-device-access",
            serde_json::json!({
                "reason": unavailable.reason,
                "remedy": unavailable.remedy,
            }),
        ),
    };
    serde_json::json!({
        "protocol": crate::protocol::PROTOCOL_VERSION,
        "engine": format!("desklink-host/{}", env!("CARGO_PKG_VERSION")),
        "platform": "linux",
        "session": { "kind": session_kind },
        "x11": { "available": x11.is_array(), "size": x11 },
        "capture": {
            "mechanism": "portal-screencast+pipewire",
            // Backends this build has, not a claim that both are usable here; the
            // portal is preferred and needs the user's consent, the X display is
            // available whenever DISPLAY points at a server.
            "backends": ["portal-screencast+pipewire", "x11-root"],
            "formats": ["bgrx", "bgra", "rgbx", "rgba"],
            "cursor": "embedded",
            "audio": false,
        },
        "encode": { "codecs": ["vp9"], "hardware": false },
        "input": {
            "mechanism": "inputtino/uinput",
            "pointer": input,
            "wheel": input,
            "keyboard": input,
            "text": ["layout-reachable"],
            "layout": keymap::LayoutNames::from_environment().identity(),
            "unavailable_reason": unavailable,
            "grant": grant_state,
        },
        "clipboard": { "read": clipboard, "write": clipboard && clipboard::writer_available(), "mime": ["text/plain;charset=utf-8"],
                       "maxBytes": clipboard::MAX_CLIPBOARD_BYTES },
    })
}

impl Session {
    pub async fn open(
        request: OpenRequest,
        events: tokio_mpsc::UnboundedSender<Notice>,
    ) -> std::result::Result<Self, SessionError> {
        let id = opaque_id();
        let wants_control = request.permissions.contains(&Permission::Control);
        let wants_x11 = matches!(request.source, Some(SourceRequest::X11 { .. }));
        // Which desktop decides which input path is even available: an X display
        // takes XTest, which cannot reach any other session, while a portal
        // desktop needs kernel input access.
        if wants_control && !wants_x11 {
            // Refuse up front rather than presenting a control surface that
            // silently does nothing.
            if let Err(unavailable) = crate::input::probe() {
                return Err(SessionError::new(
                    "input-unavailable",
                    format!("{}; {}", unavailable.reason, unavailable.remedy),
                ));
            }
        }

        let metrics = Arc::new(Mutex::new(Metrics::default()));
        let (frame_tx, frame_rx) = latest_frame();
        let captured = metrics.clone();
        let sink = Box::new(move |frame: I420, _seq: u64| {
            if let Ok(mut m) = captured.lock() {
                m.captured_frames += 1;
            }
            // An encoder that is behind gets the newest frame, not a queue: a
            // desktop stream is live, and the last state is the one that counts.
            if frame_tx.put(frame) {
                if let Ok(mut m) = captured.lock() {
                    m.dropped_frames += 1;
                }
            }
        });

        let Selected {
            source,
            capture,
            x11,
        } = match request.source.clone() {
            Some(SourceRequest::X11 { display }) => {
                select_x11(display.as_deref(), request.max_width, request.max_height, request.max_fps, metrics.clone(), sink)
                    .map_err(|error| SessionError::new("source", format!("{error:#}")))?
            }
            _ => {
                let portal = portal::open(request.restore_token.as_deref())
                    .await
                    .map_err(|error| SessionError::new("source", format!("{error:#}")))?;
                if let Some(token) = &portal.restore_token {
                    let _ = events.send(Notice {
                        session_id: id.clone(),
                        event: SessionEvent::RestoreToken(token.clone()),
                    });
                }
                let source = portal.source.clone();
                let source_w = source.width.max(1) as usize;
                let source_h = source.height.max(1) as usize;
                let (width, height) = fit(source_w, source_h, request.max_width, request.max_height);
                let capture = capture::start(portal, width, height, sink)
                    .map_err(|error| SessionError::new("source", format!("{error:#}")))?;
                Selected {
                    source,
                    capture: FrameSource::Portal(capture),
                    x11: None,
                }
            }
        };

        let source_w = source.width.max(1) as usize;
        let source_h = source.height.max(1) as usize;
        let (width, height) = fit(source_w, source_h, request.max_width, request.max_height);

        let bitrate_kbps = if request.bitrate_kbps == 0 {
            auto_bitrate(width, height)
        } else {
            request.bitrate_kbps
        };
        let encoder = Encoder::new(
            width,
            height,
            bitrate_kbps,
            request.max_fps,
            available_parallelism().min(8) as u32,
        )
        .map_err(|error| SessionError::new("encode", format!("{error:#}")))?;

        // Everything that can still refuse the session comes before the peer:
        // a peer created and then abandoned keeps its socket and tasks alive.
        let input = if !wants_control {
            None
        } else {
            Some(match &x11 {
                Some(desktop) => InputTarget {
                    applier: Applier::X11(desktop.clone()),
                    held: HeldState::default(),
                    wheel_rest: (0.0, 0.0),
                },
                None => InputTarget {
                    applier: Applier::Uinput(
                        InputDevices::create(source_w as i32, source_h as i32).map_err(|error| {
                            SessionError::new("input-unavailable", format!("{error:#}"))
                        })?,
                    ),
                    held: HeldState::default(),
                    wheel_rest: (0.0, 0.0),
                },
            })
        };

        let layout = Layout::from_environment()
            .map_err(|error| SessionError::new("input", format!("no keyboard layout: {error:#}")))?;

        let (peer_events_tx, peer_events_rx) = tokio_mpsc::unbounded_channel::<PeerEvent>();
        let (peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: request.ice_servers.clone(),
                relay_only: request.relay_only,
                // Well above the rate target, so pacing only spreads a large
                // frame over a few tens of milliseconds and never queues.
                pace_bps: (bitrate_kbps as f64 * 3_000.0).max(20_000_000.0),
            },
            peer_events_tx,
        )
        .await
        .map_err(|error| SessionError::new("transport", format!("{error:#}")))?;

        let generation = 1u64;
        let geometry = serde_json::json!({
            "source": { "width": source_w, "height": source_h },
            "encoded": { "width": width, "height": height },
            "origin": { "x": source.origin_x, "y": source.origin_y },
        });

        let pipeline = Arc::new(AtomicBool::new(true));
        let inner = Arc::new(Inner {
            id,
            generation,
            permissions: request.permissions,
            source,
            geometry,
            metrics,
            peer: Arc::new(peer),
            encoder: Mutex::new(encoder),
            input: Mutex::new(input),
            capture: Mutex::new(Some(capture)),
            layout: Mutex::new(layout),
            last_seq: Mutex::new(0),
            control_open: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            pipeline: pipeline.clone(),
            events: events.clone(),
        });

        inner.notify(SessionEvent::Description {
            generation,
            sdp: offer,
        });
        inner.notify(SessionEvent::State {
            capture: "consented",
            transport: String::from("new"),
            first_frame: false,
        });

        spawn_pipeline(&inner, frame_rx, pipeline, request.max_fps, bitrate_kbps);
        spawn_peer_events(&inner, peer_events_rx);
        spawn_lease(&inner, request.ttl.unwrap_or(Duration::from_secs(3600)));

        Ok(Self { inner })
    }

    pub fn id(&self) -> &str {
        &self.inner.id
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    pub fn geometry(&self) -> &serde_json::Value {
        &self.inner.geometry
    }

    pub fn source(&self) -> &SelectedSource {
        &self.inner.source
    }

    pub fn metrics(&self) -> Metrics {
        self.inner
            .metrics
            .lock()
            .map(|m| m.clone())
            .unwrap_or_default()
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<()> {
        self.inner.peer.accept_answer(sdp).await.map(|_applied| ())
    }

    pub async fn add_candidate(
        &self,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> Result<()> {
        self.inner
            .peer
            .add_candidate(candidate, sdp_mid, sdp_m_line_index)
            .await
    }

    /// Read the desktop clipboard for the consumer. Explicit, never polled.
    pub async fn read_clipboard(&self) -> std::result::Result<(String, bool), String> {
        if !self.inner.permissions.contains(&Permission::Clipboard) {
            return Err(String::from("this session has no clipboard permission"));
        }
        clipboard_task(move || clipboard::read_or_explain()).await
    }

    pub async fn write_clipboard(&self, text: String) -> std::result::Result<(), String> {
        if !self.inner.permissions.contains(&Permission::Clipboard) {
            return Err(String::from("this session has no clipboard permission"));
        }
        clipboard_task(move || {
            clipboard::write(&text)
                .map(|()| String::new())
                .map_err(|error| format!("{error:#}"))
        })
        .await
        .map(|_written| ())
    }

    pub fn mark_closed_reason(&self) -> Option<String> {
        self.inner.revoked_reason()
    }

    /// The source kind this session captures, e.g. `monitor`.
    pub fn restore_source(&self) -> String {
        self.inner.source.source_type.clone().unwrap_or_else(|| String::from("monitor"))
    }

    pub async fn close(&self, reason: &str) {
        self.inner.close(reason).await;
    }
}

impl Inner {
    /// Send one notification, stamped with the session it belongs to.
    fn notify(&self, event: SessionEvent) {
        let _ = self.events.send(Notice {
            session_id: self.id.clone(),
            event,
        });
    }

    /// Stop everything and release whatever input this session held. Idempotent,
    /// and the one teardown both an explicit close and a lease expiry take.
    async fn close(&self, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.control_open.store(false, Ordering::SeqCst);
        self.pipeline.store(false, Ordering::SeqCst);
        // Release first, then tear down: a stuck modifier is the one failure the
        // user cannot undo by reconnecting.
        if let Ok(mut input) = self.input.lock() {
            if let Some(target) = input.as_mut() {
                let _ = target.release_all();
            }
            *input = None;
        }
        let _ = self.peer.send_control(
            &serde_json::to_string(&ControlReply::Revoked { reason })
                .unwrap_or_else(|_| String::from(r#"{"kind":"revoked","reason":"closed"}"#)),
        ).await;
        self.peer.close().await;
        // Dropping the capture stops the PipeWire stream and joins its thread,
        // which is what releases the compositor's consent for this session. It
        // has to happen synchronously, not when the last handle happens to fall
        // out of scope, so the consumer can truthfully say the desktop stopped.
        let capture = self.capture.lock().ok().and_then(|mut held| held.take());
        drop(capture);
        self.notify(SessionEvent::State {
            capture: "ended",
            transport: String::from("closed"),
            first_frame: false,
        });
    }

    fn revoked_reason(&self) -> Option<String> {
        if self.closed.load(Ordering::Relaxed) {
            Some(String::from("session closed"))
        } else {
            None
        }
    }

    fn has(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    fn reject(&self, seq: u64, code: &'static str, message: &str) {
        if let Ok(mut m) = self.metrics.lock() {
            m.input_rejected += 1;
        }
        let payload = ControlReply::Rejected { seq, code, message };
        let _ = self.reply(&payload);
    }

    fn reply(&self, payload: &ControlReply<'_>) -> Result<()> {
        let text = serde_json::to_string(payload)?;
        // The channel is asynchronous; a failure here means the peer is gone,
        // which the connection-state handler closes anyway.
        let peer = self.peer.clone();
        tokio::spawn(async move {
            let _ = peer.send_control(&text).await;
        });
        Ok(())
    }

    /// Admit one client action. Validation, permission and ordering checks all
    /// happen before any physical effect, so a refused action leaves the desktop
    /// exactly as it was.
    fn apply(self: &Arc<Self>, message: ControlMessage) {
        let seq = message.seq();
        if self.closed.load(Ordering::Relaxed) {
            self.reject(seq, "session", "the session has ended");
            return;
        }
        if !self.control_open.load(Ordering::Relaxed) {
            self.reject(seq, "session", "the control channel is not open");
            return;
        }
        if !self.has(Permission::Control) {
            self.reject(seq, "permission", "this session is view-only");
            return;
        }
        if seq != 0 {
            let mut last = match self.last_seq.lock() {
                Ok(last) => last,
                Err(_) => return,
            };
            if seq <= *last {
                drop(last);
                self.reject(seq, "input-replay", "sequence already applied");
                return;
            }
            *last = seq;
        }
        let outcome = match message {
            ControlMessage::Pointer {
                phase, x, y, button, ..
            } => self.pointer(phase, x, y, button, seq),
            ControlMessage::Wheel { dx, dy, .. } => self.wheel(dx, dy, seq),
            ControlMessage::Key {
                name,
                character,
                down,
                modifiers,
                ..
            } => self.key(name, character, down, modifiers, seq),
            ControlMessage::Text { text, .. } => self.text(&text, seq),
            ControlMessage::ReleaseAll { .. } => {
                if let Ok(mut input) = self.input.lock() {
                    if let Some(target) = input.as_mut() {
                        let _ = target.release_all();
                    }
                }
                Ok(())
            }
            ControlMessage::ClipboardRead { request, .. } => {
                self.clipboard_read(request);
                return;
            }
            ControlMessage::ClipboardWrite { request, text, .. } => {
                self.clipboard_write(request, text);
                return;
            }
        };
        match outcome {
            Ok(()) => {
                if let Ok(mut m) = self.metrics.lock() {
                    m.input_applied += 1;
                }
                let _ = self.reply(&ControlReply::Ack { seq });
            }
            Err((code, message)) => self.reject(seq, code, &message),
        }
    }

    fn with_input<T>(
        &self,
        action: impl FnOnce(&mut InputTarget) -> Result<T>,
    ) -> std::result::Result<T, (&'static str, String)> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| ("session", String::from("the input device is unavailable")))?;
        match input.as_mut() {
            Some(target) => action(target).map_err(|error| ("input", format!("{error:#}"))),
            None => Err(("input-unavailable", String::from("no input backend"))),
        }
    }

    fn pointer(
        &self,
        phase: PointerPhase,
        x: i64,
        y: i64,
        button: i64,
        _seq: u64,
    ) -> std::result::Result<(), (&'static str, String)> {
        let (width, height) = self.encoded_size();
        if !(0..width as i64).contains(&x) || !(0..height as i64).contains(&y) {
            return Err((
                "coordinates",
                format!("({x},{y}) is outside the {width}x{height} surface"),
            ));
        }
        // The client sends the encoded surface's own pixels; the applier is
        // created for, and clamps to, the source's own pixels. One conversion
        // here keeps every caller honest.
        let (x, y) = to_source_pixels(x, y, (width, height), &self.source);
        self.with_input(|target| match phase {
            PointerPhase::Move => target.move_absolute(x, y),
            PointerPhase::Down => {
                target.move_absolute(x, y)?;
                target.button(Button::from_number(button), true)
            }
            PointerPhase::Up => {
                target.move_absolute(x, y)?;
                target.button(Button::from_number(button), false)
            }
            PointerPhase::Cancel => target.release_all(),
        })
    }

    fn wheel(&self, dx: f64, dy: f64, _seq: u64) -> std::result::Result<(), (&'static str, String)> {
        if !dx.is_finite() || !dy.is_finite() || dx.abs() > 100.0 || dy.abs() > 100.0 {
            return Err(("coordinates", String::from("scroll delta is out of range")));
        }
        self.with_input(|target| target.scroll(dx, dy))
    }

    fn key(
        &self,
        name: Option<String>,
        character: Option<String>,
        down: bool,
        modifiers: Vec<String>,
        _seq: u64,
    ) -> std::result::Result<(), (&'static str, String)> {
        // A named modifier is applied directly: it is the same key the user
        // would press, and it does not depend on the layout.
        if let Some(name) = &name {
            if let Some(code) = keymap::modifier_key(name) {
                return self.with_input(|target| target.key(code, down));
            }
        }

        let stroke = {
            let layout = self
                .layout
                .lock()
                .map_err(|_| ("session", String::from("no keyboard layout")))?;
            if let Some(name) = name {
                keymap::named_key(&name)
                    .ok_or(("text-unsupported", format!("unknown key {name}")))?
            } else if let Some(character) = character {
                let wanted = character
                    .chars()
                    .next()
                    .ok_or(("text-unsupported", String::from("empty character")))?;
                layout.keystroke_for_char(wanted).ok_or((
                    "text-unsupported",
                    format!("the active layout cannot produce {wanted:?}"),
                ))?
            } else {
                return Err(("text-unsupported", String::from("no key given")));
            }
        };

        // Explicitly requested modifiers travel with this key only.
        let mut requested: Vec<i16> = modifiers
            .iter()
            .filter_map(|name| keymap::modifier_key(name))
            .collect();
        requested.extend(stroke.modifiers());

        self.with_input(|target| {
            target.check_keys(requested.iter().copied().chain(std::iter::once(stroke.code)))?;
            if down {
                for modifier in &requested {
                    target.key(*modifier, true)?;
                }
            }
            target.key(stroke.code, down)?;
            if !down {
                for modifier in requested.iter().rev() {
                    target.key(*modifier, false)?;
                }
            }
            Ok(())
        })
    }

    fn text(&self, text: &str, seq: u64) -> std::result::Result<(), (&'static str, String)> {
        if text.len() > 4096 {
            return Err(("text-too-large", String::from("text exceeds 4096 bytes")));
        }
        let layout = self
            .layout
            .lock()
            .map_err(|_| ("session", String::from("no keyboard layout")))?;
        let (plan, unreachable) = layout.plan_text(text);
        drop(layout);
        if !unreachable.is_empty() {
            return Err((
                "text-unsupported",
                format!("the active layout cannot produce {unreachable:?}; use the clipboard"),
            ));
        }
        let _ = seq;
        self.with_input(|target| {
            // Refuse an unsupported physical key before typing any prefix or
            // holding a modifier. X11 already consumes evdev identities.
            target.check_keys(plan.iter().flatten().flat_map(|stroke| {
                std::iter::once(stroke.code).chain(stroke.modifiers())
            }))?;
            for keystroke in plan {
                for stroke in keystroke {
                    let modifiers = stroke.modifiers();
                    for modifier in &modifiers {
                        target.key(*modifier, true)?;
                    }
                    target.key(stroke.code, true)?;
                    target.key(stroke.code, false)?;
                    for modifier in modifiers.iter().rev() {
                        target.key(*modifier, false)?;
                    }
                }
            }
            Ok(())
        })
    }

    fn clipboard_read(self: &Arc<Self>, request: String) {
        if !self.has(Permission::Clipboard) {
            self.reject(0, "permission", "this session has no clipboard permission");
            return;
        }
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let (text, truncated, error) = match clipboard_task(clipboard::read_or_explain).await {
                Ok((text, truncated)) => (text, truncated, None),
                Err(reason) => (String::new(), false, Some(reason)),
            };
            let _ = inner.reply(&ControlReply::Clipboard {
                request: &request,
                text,
                truncated,
                error: error.as_deref(),
            });
        });
    }

    fn clipboard_write(self: &Arc<Self>, request: String, text: String) {
        if !self.has(Permission::Clipboard) {
            self.reject(0, "permission", "this session has no clipboard permission");
            return;
        }
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let error = clipboard_task(move || {
                clipboard::write(&text).map(|()| String::new()).map_err(|error| format!("{error:#}"))
            })
            .await
            .err();
            let _ = inner.reply(&ControlReply::Clipboard {
                request: &request,
                text: String::new(),
                truncated: false,
                error: error.as_deref(),
            });
        });
    }

    fn encoded_size(&self) -> (usize, usize) {
        let encoded = &self.geometry["encoded"];
        (
            encoded["width"].as_u64().unwrap_or(0) as usize,
            encoded["height"].as_u64().unwrap_or(0) as usize,
        )
    }
}

/// The interval between frames at `max_fps`. The requested rate is a cap, so the
/// pipeline and the X11 capture loop derive their cadence from the same rule.
fn frame_interval(max_fps: u32) -> Duration {
    Duration::from_secs_f64(1.0 / max_fps.max(1) as f64)
}

/// The newest captured frame, handed from the capture thread to the encoder. A
/// newer frame replaces one the encoder has not taken, so however far behind
/// it falls, what it codes next is the desktop as it is now.
struct FrameSlot {
    frame: Mutex<(Option<I420>, bool)>,
    ready: Condvar,
}

struct FrameSender(Arc<FrameSlot>);
struct FrameReceiver(Arc<FrameSlot>);

fn latest_frame() -> (FrameSender, FrameReceiver) {
    let slot = Arc::new(FrameSlot { frame: Mutex::new((None, false)), ready: Condvar::new() });
    (FrameSender(slot.clone()), FrameReceiver(slot))
}

impl FrameSender {
    /// Hand over a frame; true when it replaced one the encoder never took.
    fn put(&self, frame: I420) -> bool {
        let mut held = self.0.frame.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let replaced = held.0.replace(frame).is_some();
        self.0.ready.notify_one();
        replaced
    }
}

impl Drop for FrameSender {
    /// The capture stopped: the encoder ends once it has taken what is left.
    fn drop(&mut self) {
        let mut held = self.0.frame.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        held.1 = true;
        self.0.ready.notify_one();
    }
}

enum Taken {
    Frame(I420),
    Timeout,
    Ended,
}

impl FrameReceiver {
    fn take(&self, wait: Duration) -> Taken {
        let held = self.0.frame.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (mut held, _) = self
            .0
            .ready
            .wait_timeout_while(held, wait, |(frame, ended)| frame.is_none() && !*ended)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match held.0.take() {
            Some(frame) => Taken::Frame(frame),
            None if held.1 => Taken::Ended,
            None => Taken::Timeout,
        }
    }
}

/// How long the desktop has to stay still before its last frame is refined.
/// Long enough that a pause between keystrokes does not pay for a refinement
/// the next key makes stale; short enough that reading does not wait for it.
const REFINE_AFTER: Duration = Duration::from_millis(150);

/// The longest the stream goes without a frame while the desktop is still. A
/// WebRTC receiver that has had no decodable frame for a few seconds asks for
/// a key frame (a 4K one is hundreds of kilobytes), then asks again after the
/// next quiet spell. An unchanged frame costs a few hundred bytes and keeps it
/// satisfied.
const KEEPALIVE_AFTER: Duration = Duration::from_millis(1000);

/// The rate target for a surface when the consumer did not choose one: enough
/// for a scroll across a full 4K desktop to stay legible. A still desktop costs
/// almost nothing whatever this says.
fn auto_bitrate(width: usize, height: usize) -> u32 {
    (1500 + (width * height * 18 / 10_000) as u32).min(25_000)
}

/// Loss-based rate target: back off quickly when the far end reports loss,
/// creep back when it reports none, never above what the session asked for.
struct RateControl {
    ceiling: u32,
    target: u32,
    last_change: Option<Instant>,
}

impl RateControl {
    fn new(ceiling: u32) -> Self {
        Self { ceiling, target: ceiling, last_change: None }
    }

    /// The new target when these reports move it, at most once a second.
    fn update(&mut self, reports: &[u8], now: Instant) -> Option<u32> {
        let worst = *reports.iter().max()?;
        if self.last_change.is_some_and(|at| now.duration_since(at) < Duration::from_secs(1)) {
            return None;
        }
        let loss = worst as f64 / 256.0;
        let floor = (self.ceiling / 8).max(500);
        let next = if loss > 0.10 {
            ((self.target as f64 * 0.7) as u32).max(floor)
        } else if loss < 0.02 {
            ((self.target as f64 * 1.08) as u32 + 64).min(self.ceiling)
        } else {
            self.target
        };
        if next == self.target {
            return None;
        }
        self.target = next;
        self.last_change = Some(now);
        Some(next)
    }
}

enum Pass {
    Motion { keyframe: bool },
    Refine,
    /// The same picture again, so a still stream never looks stalled.
    Keepalive,
}

/// Encode and send frames off the async runtime: libvpx blocks for the duration
/// of a frame and the send is asynchronous, so a plain thread driving the
/// runtime handle keeps both honest.
///
/// PipeWire delivers a frame only when the desktop changes. Every frame that
/// arrives is either coded or superseded by a newer one within one frame
/// interval, so the phone never shows a state older than the desktop's; the
/// rate cap delays a frame rather than dropping the last one of a burst. When
/// the desktop goes still the last frame is coded once more, sharp.
fn spawn_pipeline(inner: &Arc<Inner>, frame_rx: FrameReceiver, running: Arc<AtomicBool>, max_fps: u32, bitrate_kbps: u32) {
    let inner = inner.clone();
    let handle = tokio::runtime::Handle::current();
    std::thread::Builder::new()
        .name("desklink-encode".into())
        .spawn(move || {
            let interval = frame_interval(max_fps);
            let mut rate = RateControl::new(bitrate_kbps);
            if let Ok(mut m) = inner.metrics.lock() {
                m.target_kbps = bitrate_kbps;
            }
            let mut latest: Option<I420> = None;
            // `pending`: the latest frame has not been coded. `refined`: it has
            // had its refinement pass, or there is nothing to refine.
            let mut pending = false;
            let mut refined = true;
            let mut keyframe = true;
            let mut still_since = Instant::now();
            let mut last_sent: Option<Instant> = None;
            loop {
                let now = Instant::now();
                let slot = last_sent.map_or(Duration::ZERO, |at| interval.saturating_sub(now.duration_since(at)));
                let connected = inner.peer.is_connected();
                let wait = if !connected {
                    // Nothing sent before the transport connects arrives; the
                    // first frame after it is a key frame.
                    Duration::from_millis(50)
                } else if pending {
                    slot
                } else if !refined {
                    REFINE_AFTER.saturating_sub(now.duration_since(still_since)).max(slot)
                } else {
                    last_sent.map_or(Duration::from_millis(100), |at| KEEPALIVE_AFTER.saturating_sub(now.duration_since(at)))
                        .clamp(Duration::from_millis(10), Duration::from_millis(100))
                };
                match frame_rx.take(wait) {
                    Taken::Frame(frame) => {
                        if pending {
                            if let Ok(mut m) = inner.metrics.lock() {
                                m.dropped_frames += 1;
                            }
                        }
                        latest = Some(frame);
                        pending = true;
                        refined = false;
                        still_since = Instant::now();
                    }
                    Taken::Timeout => {}
                    Taken::Ended => break,
                }
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                if inner.peer.take_keyframe_request() || !connected {
                    keyframe = true;
                }
                let reports = inner.peer.take_loss_reports();
                if let Some(kbps) = rate.update(&reports, Instant::now()) {
                    let applied = inner.encoder.lock().map(|mut encoder| encoder.set_bitrate(kbps));
                    if matches!(applied, Ok(Ok(()))) {
                        if let Ok(mut m) = inner.metrics.lock() {
                            m.target_kbps = kbps;
                        }
                    }
                }
                let Some(frame) = latest.as_ref() else { continue };
                if !connected {
                    continue;
                }
                let now = Instant::now();
                if last_sent.is_some_and(|at| now.duration_since(at) < interval) {
                    continue;
                }
                let pass = if pending || keyframe {
                    Pass::Motion { keyframe }
                } else if !refined && now.duration_since(still_since) >= REFINE_AFTER {
                    Pass::Refine
                } else if refined && last_sent.is_some_and(|at| now.duration_since(at) >= KEEPALIVE_AFTER) {
                    Pass::Keepalive
                } else {
                    continue;
                };

                let started = Instant::now();
                let packet = {
                    let mut encoder = match inner.encoder.lock() {
                        Ok(encoder) => encoder,
                        Err(_) => break,
                    };
                    match pass {
                        Pass::Motion { keyframe } => encoder.encode(frame, keyframe),
                        Pass::Refine => encoder.refine(frame),
                        Pass::Keepalive => encoder.encode(frame, false),
                    }
                };
                let packet = match packet {
                    Ok(packet) => packet,
                    Err(error) => {
                        if let Ok(mut m) = inner.metrics.lock() {
                            m.dropped_frames += 1;
                        }
                        // The encoder refusing a frame means it is not the size
                        // it was built for, or libvpx rejected it. Both leave a
                        // permanently black desktop, so end the session instead
                        // of dropping frames in silence; the client turns this
                        // reason into what it shows the user.
                        eprintln!("the encoder rejected a frame: {error:#}");
                        let reason = String::from("the encoder rejected a frame");
                        inner.notify(SessionEvent::Revoked { reason: reason.clone() });
                        let target = inner.clone();
                        handle.spawn(async move { target.close(&reason).await; });
                        break;
                    }
                };
                if let Ok(mut m) = inner.metrics.lock() {
                    m.encoded_frames += 1;
                    m.encoded_bytes += packet.data.len() as u64;
                    m.encode_micros += started.elapsed().as_micros() as u64;
                    match pass {
                        Pass::Motion { keyframe: true } => m.key_frames += 1,
                        Pass::Refine => m.refined_frames += 1,
                        Pass::Motion { keyframe: false } | Pass::Keepalive => {}
                    }
                }
                match pass {
                    Pass::Motion { .. } => {
                        pending = false;
                        keyframe = false;
                        refined = false;
                        still_since = now;
                    }
                    Pass::Refine => refined = true,
                    Pass::Keepalive => {}
                }
                last_sent = Some(now);
                let peer = inner.peer.clone();
                if let Err(error) = handle.block_on(peer.send_frame(&packet.data, packet.keyframe, now)) {
                    // The transport is gone. End the session rather than leave
                    // the desktop captured behind a picture that stopped.
                    eprintln!("the video track refused an encoded frame: {error:#}");
                    let reason = String::from("the connection to the phone was lost");
                    inner.notify(SessionEvent::Revoked { reason: reason.clone() });
                    let target = inner.clone();
                    handle.spawn(async move { target.close(&reason).await; });
                    break;
                }
            }
        })
        .ok();
}

fn spawn_peer_events(inner: &Arc<Inner>, mut events: tokio_mpsc::UnboundedReceiver<PeerEvent>) {
    let inner = inner.clone();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if inner.closed.load(Ordering::SeqCst) {
                break;
            }
            match event {
                PeerEvent::Candidate {
                    candidate,
                    sdp_mid,
                    sdp_m_line_index,
                } => {
                    inner.notify(SessionEvent::Candidate {
                        generation: inner.generation,
                        candidate,
                        sdp_mid,
                        sdp_m_line_index,
                    });
                }
                PeerEvent::State(state) => {
                    use webrtc::peer_connection::RTCPeerConnectionState as State;
                    // ICE loss need not close SCTP. Never leave a drag or chord
                    // held while waiting for that independent notification.
                    if matches!(state, State::Disconnected | State::Failed | State::Closed) {
                        if let Ok(mut input) = inner.input.lock() {
                            if let Some(target) = input.as_mut() {
                                let _ = target.release_all();
                            }
                        }
                    }
                    if matches!(state, State::Failed | State::Closed) {
                        let reason = String::from("the connection to the phone was lost");
                        inner.notify(SessionEvent::Revoked { reason: reason.clone() });
                        inner.close(&reason).await;
                        continue;
                    }
                    inner.notify(SessionEvent::State {
                        capture: if inner.metrics.lock().map(|m| m.encoded_frames).unwrap_or(0) > 0 {
                            "streaming"
                        } else {
                            "consented"
                        },
                        transport: format!("{state}").to_lowercase(),
                        first_frame: inner.metrics.lock().map(|m| m.encoded_frames).unwrap_or(0) > 0,
                    });
                }
                PeerEvent::ControlOpen => {
                    inner.control_open.store(true, Ordering::SeqCst);
                    let payload = ControlReply::Hello {
                        protocol: crate::protocol::PROTOCOL_VERSION,
                        geometry: inner.geometry.clone(),
                    };
                    let _ = inner.reply(&payload);
                }
                PeerEvent::ControlClosed => {
                    inner.control_open.store(false, Ordering::SeqCst);
                    // A client that vanished must not leave a button held.
                    if let Ok(mut input) = inner.input.lock() {
                        if let Some(target) = input.as_mut() {
                            let _ = target.release_all();
                        }
                    }
                }
                PeerEvent::ControlMessage(text) => match serde_json::from_str::<ControlMessage>(&text)
                {
                    Ok(message) => inner.apply(message),
                    Err(_) => inner.reject(0, "operation", "unrecognised control message"),
                },
            }
        }
    });
}

fn spawn_lease(inner: &Arc<Inner>, ttl: Duration) {
    let inner = inner.clone();
    tokio::spawn(async move {
        tokio::time::sleep(ttl).await;
        if inner.closed.load(Ordering::SeqCst) {
            return;
        }
        let reason = String::from("the session lease expired");
        inner.notify(SessionEvent::Revoked { reason: reason.clone() });
        // An expiry ends the session exactly as an explicit close does; the
        // notification above is not a substitute for stopping the desktop.
        inner.close(&reason).await;
    });
}

fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Encoded-surface pixels to the source's own pixels. The client aims at what it
/// sees; the applier is sized and clamped to the source, so the layout origin
/// must not be added here.
fn to_source_pixels(
    x: i64,
    y: i64,
    encoded: (usize, usize),
    source: &SelectedSource,
) -> (i64, i64) {
    let (width, height) = encoded;
    (
        x * source.width as i64 / width as i64,
        y * source.height as i64 / height as i64,
    )
}

fn opaque_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_source_is_never_upscaled() {
        assert_eq!(fit(1000, 600, 1280, 800), (1000, 600));
    }

    #[test]
    fn a_large_source_is_fitted_into_the_box_with_even_dimensions() {
        let (w, h) = fit(2560, 1440, 1280, 800);
        assert_eq!((w, h), (1280, 720));
        assert_eq!((w % 2, h % 2), (0, 0));
    }

    #[test]
    fn fit_keeps_the_aspect_ratio_when_the_box_is_the_constraint() {
        assert_eq!(fit(2560, 1440, 1200, 600), (1066, 600));
    }

    #[test]
    fn an_encoded_surface_pixel_maps_to_the_sources_own_pixel() {
        let source = SelectedSource {
            node_id: 0,
            width: 2560,
            height: 1440,
            position: Some((1920, 0)),
            source_type: None,
            origin_x: 1920,
            origin_y: 0,
        };
        // A tap at the centre of a 1280x720 surface must reach the centre of the
        // 2560x1440 source, not two thirds of the way there; a tap in the right
        // half must stay source-local rather than land on a layout origin the
        // applier would clamp away.
        assert_eq!(to_source_pixels(640, 360, (1280, 720), &source), (1280, 720));
        assert_eq!(to_source_pixels(1279, 719, (1280, 720), &source), (2558, 1438));
        assert_eq!(to_source_pixels(0, 0, (1280, 720), &source), (0, 0));
    }

    async fn test_inner(events: tokio_mpsc::UnboundedSender<Notice>) -> (Arc<Inner>, Arc<Mutex<Vec<(i16, bool)>>>) {
        let (peer_events, _peer_events_rx) = tokio_mpsc::unbounded_channel();
        let (peer, _offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                relay_only: false,
                pace_bps: 20_000_000.0,
            },
            peer_events,
        )
        .await
        .expect("a peer connection builds without a network");
        // The pipeline codes nothing before the transport connects.
        peer.assume_connected();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let inner = Arc::new(Inner {
            id: String::from("test-session"),
            generation: 1,
            permissions: vec![Permission::Control],
            source: SelectedSource {
                node_id: 0,
                width: 640,
                height: 480,
                position: None,
                source_type: None,
                origin_x: 0,
                origin_y: 0,
            },
            geometry: serde_json::json!({
                "source": { "width": 640, "height": 480 },
                "encoded": { "width": 640, "height": 480 },
                "origin": { "x": 0, "y": 0 },
            }),
            metrics: Arc::new(Mutex::new(Metrics::default())),
            peer: Arc::new(peer),
            encoder: Mutex::new(Encoder::new(64, 64, 1000, 30, 1).expect("an encoder")),
            input: Mutex::new(Some(InputTarget {
                applier: Applier::Recording(recorded.clone()),
                held: HeldState::default(),
                wheel_rest: (0.0, 0.0),
            })),
            capture: Mutex::new(None),
            layout: Mutex::new(Layout::from_environment().expect("a keymap")),
            last_seq: Mutex::new(0),
            control_open: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            pipeline: Arc::new(AtomicBool::new(true)),
            events,
        });
        (inner, recorded)
    }

    #[tokio::test]
    async fn a_lease_that_expires_ends_the_session_and_releases_held_input() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let (inner, recorded) = test_inner(events).await;

        inner.apply(ControlMessage::Key {
            name: None,
            character: Some(String::from("a")),
            down: true,
            modifiers: Vec::new(),
            seq: 1,
        });
        assert!(
            recorded.lock().unwrap().iter().any(|(_, down)| *down),
            "the press reached the desktop",
        );

        spawn_lease(&inner, Duration::from_millis(20));
        tokio::time::sleep(Duration::from_millis(150)).await;

        assert!(inner.revoked_reason().is_some(), "an expired lease must end the session");
        assert!(
            !inner.pipeline.load(Ordering::SeqCst),
            "an expired lease must stop capture",
        );
        assert!(
            recorded.lock().unwrap().iter().any(|(_, down)| !*down),
            "an expired lease must release what the session pressed",
        );
        assert!(
            matches!(received.try_recv(), Ok(Notice { event: SessionEvent::Revoked { .. }, .. })),
            "the consumer is still told why the session ended",
        );

        let rejected = inner.metrics.lock().unwrap().input_rejected;
        inner.apply(ControlMessage::Key {
            name: None,
            character: Some(String::from("b")),
            down: true,
            modifiers: Vec::new(),
            seq: 2,
        });
        assert_eq!(
            inner.metrics.lock().unwrap().input_rejected,
            rejected + 1,
            "a control message after expiry must be refused",
        );
    }

    #[tokio::test]
    async fn a_frame_the_encoder_refuses_ends_the_session_with_a_reason() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let (inner, _recorded) = test_inner(events).await;
        let (frame_tx, frame_rx) = latest_frame();
        spawn_pipeline(&inner, frame_rx, Arc::new(AtomicBool::new(true)), 30, 1000);

        // The encoder is 64x64; a 32x32 frame is the dimension mismatch that
        // used to be counted and dropped behind a permanently black picture.
        frame_tx.put(I420 {
            width: 32,
            height: 32,
            data: vec![128u8; 32 * 32 + 2 * 16 * 16],
        });
        tokio::time::sleep(Duration::from_millis(150)).await;

        let mut reason = None;
        while let Ok(event) = received.try_recv() {
            if let Notice {
                event: SessionEvent::Revoked { reason: why },
                ..
            } = event
            {
                reason = Some(why);
            }
        }
        let reason = reason.expect("a refused frame must surface as a revocation");
        assert_eq!(
            reason,
            "the encoder rejected a frame",
            "the reason is a stable token the client can map to copy",
        );
        assert!(inner.revoked_reason().is_some(), "the session is closed, not left black");
    }

    #[tokio::test]
    async fn a_lost_transport_releases_input_then_ends_the_session_without_sctp_close() {
        use webrtc::peer_connection::RTCPeerConnectionState as State;
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let (inner, recorded) = test_inner(events).await;
        inner.apply(ControlMessage::Key {
            name: Some(String::from("Control")),
            character: None,
            down: true,
            modifiers: Vec::new(),
            seq: 1,
        });
        assert!(recorded.lock().unwrap().iter().any(|(_, down)| *down));

        let (peer_tx, peer_rx) = tokio_mpsc::unbounded_channel();
        spawn_peer_events(&inner, peer_rx);
        peer_tx.send(PeerEvent::State(State::Disconnected)).unwrap();
        tokio::time::timeout(Duration::from_secs(2), received.recv()).await.unwrap();
        assert!(recorded.lock().unwrap().iter().any(|(_, down)| !*down),
            "a disconnected transport must release held input without SCTP OnClose");
        assert!(inner.revoked_reason().is_none(), "a transient loss may recover");

        peer_tx.send(PeerEvent::State(State::Failed)).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(notice) = received.recv().await {
                if matches!(notice.event, SessionEvent::State { capture: "ended", .. }) {
                    return;
                }
            }
            panic!("failed transport did not end capture");
        }).await.unwrap();
        assert!(inner.revoked_reason().is_some());
        assert!(!inner.pipeline.load(Ordering::SeqCst));
        assert!(inner.input.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn the_pipeline_caps_the_rate_codes_the_last_frame_and_refines_a_still_desktop_once() {
        let (events, _events_rx) = tokio_mpsc::unbounded_channel();
        let (inner, _recorded) = test_inner(events).await;
        let (frame_tx, frame_rx) = latest_frame();
        spawn_pipeline(&inner, frame_rx, Arc::new(AtomicBool::new(true)), 20, 1000);

        // 40 frames over 200 ms is 200 fps; the requested 20 fps caps what leaves.
        for _ in 0..40 {
            frame_tx.put(I420 {
                width: 64,
                height: 64,
                data: vec![128u8; 64 * 64 + 2 * 32 * 32],
            });
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let motion = inner.metrics.lock().unwrap().encoded_frames;
        assert!(motion <= 7, "the requested rate is a cap, got {motion} of 40");
        assert!(motion >= 2, "the pipeline must still emit frames, got {motion}");

        // Still for longer than a refinement takes: the last frame of the burst
        // is coded (a refinement only follows a coded frame), then refined once.
        tokio::time::sleep(Duration::from_millis(450)).await;
        let metrics = inner.metrics.lock().unwrap().clone();
        assert_eq!(metrics.refined_frames, 1, "a still desktop is refined exactly once");
        assert_eq!(metrics.key_frames, 1, "only the first frame is a key frame");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(inner.metrics.lock().unwrap().encoded_frames, metrics.encoded_frames, "nothing is sent while still");

        // A still stream is kept alive, so a receiver never waits long enough
        // to ask for a key frame; the keepalive is neither a key frame nor
        // another refinement.
        tokio::time::sleep(Duration::from_millis(900)).await;
        let later = inner.metrics.lock().unwrap().clone();
        assert!(later.encoded_frames > metrics.encoded_frames, "a still stream still sends");
        assert_eq!((later.key_frames, later.refined_frames), (1, 1));
    }
}
