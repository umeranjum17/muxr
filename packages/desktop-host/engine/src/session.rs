//! One authorized desktop session: capture in, VP9 out, control channel in,
//! desktop input out, and a bounded teardown.
//!
//! The engine trusts the consumer's local permission decision and enforces the
//! resulting scope. It has no second identity system, no account and no notion
//! of which application asked.

use crate::capture::{self, Capture};
use crate::clipboard;
use crate::convert::I420;
use crate::encoder::Encoder;
use crate::input::{Button, InputDevices, InputUnavailable};
use crate::keymap::{self, Layout};
use crate::peer::{PeerEvent, TransportOptions, VideoPeer};
use crate::portal::{self, SelectedSource};
use crate::protocol::{ControlMessage, ControlReply, Permission, PointerPhase};
use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc as tokio_mpsc;

/// How the capture → encode → send path is doing, reported to the consumer.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Metrics {
    pub captured_frames: u64,
    pub dropped_frames: u64,
    pub encoded_frames: u64,
    pub encoded_bytes: u64,
    pub input_applied: u64,
    pub input_rejected: u64,
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
    input: Mutex<Option<InputDevices>>,
    capture: Mutex<Option<Capture>>,
    layout: Mutex<Layout>,
    last_seq: Mutex<u64>,
    control_open: AtomicBool,
    closed: AtomicBool,
    events: tokio_mpsc::UnboundedSender<SessionEvent>,
}

pub struct Session {
    inner: Arc<Inner>,
    /// Kept alive so dropping the session stops the pipeline's frame source.
    pipeline: Arc<AtomicBool>,
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
        "capture": {
            "mechanism": "portal-screencast+pipewire",
            "formats": ["bgrx", "rgba", "nv12"],
            "cursor": "embedded",
            "audio": false,
        },
        "encode": { "codecs": ["vp9"], "hardware": false },
        "input": {
            "mechanism": "inputtino/uinput",
            "pointer": input,
            "wheel": input,
            "keyboard": input,
            "text": ["latin1", "layout-reachable"],
            "unavailable_reason": unavailable,
            "grant": grant_state,
        },
        "clipboard": { "read": true, "write": true, "mime": ["text/plain;charset=utf-8"],
                       "maxBytes": clipboard::MAX_CLIPBOARD_BYTES },
    })
}

impl Session {
    pub async fn open(
        request: OpenRequest,
        events: tokio_mpsc::UnboundedSender<SessionEvent>,
    ) -> std::result::Result<Self, SessionError> {
        let wants_control = request.permissions.contains(&Permission::Control);
        if wants_control {
            // Refuse up front rather than presenting a control surface that
            // silently does nothing.
            if let Err(unavailable) = crate::input::probe() {
                return Err(SessionError::new(
                    "input-unavailable",
                    format!("{}; {}", unavailable.reason, unavailable.remedy),
                ));
            }
        }

        let portal = portal::open(request.restore_token.as_deref())
            .await
            .map_err(|error| SessionError::new("source", format!("{error:#}")))?;
        if let Some(token) = &portal.restore_token {
            let _ = events.send(SessionEvent::RestoreToken(token.clone()));
        }

        let source = portal.source.clone();
        let source_w = source.width.max(1) as usize;
        let source_h = source.height.max(1) as usize;
        let (width, height) = fit(source_w, source_h, request.max_width, request.max_height);

        let metrics = Arc::new(Mutex::new(Metrics::default()));
        let (frame_tx, frame_rx) = std_mpsc::sync_channel::<I420>(2);
        let captured = metrics.clone();
        let capture = capture::start(
            portal,
            width,
            height,
            Box::new(move |frame, _seq| {
                if let Ok(mut m) = captured.lock() {
                    m.captured_frames += 1;
                }
                // A full queue means the far end is behind. Dropping the frame is
                // the correct backpressure: a desktop stream is live, not a file.
                if frame_tx.try_send(frame).is_err() {
                    if let Ok(mut m) = captured.lock() {
                        m.dropped_frames += 1;
                    }
                }
            }),
        )
        .map_err(|error| SessionError::new("source", format!("{error:#}")))?;

        let encoder = Encoder::new(
            width,
            height,
            request.bitrate_kbps,
            request.max_fps,
            available_parallelism().min(8) as u32,
        )
        .map_err(|error| SessionError::new("encode", format!("{error:#}")))?;

        let (peer_events_tx, peer_events_rx) = tokio_mpsc::unbounded_channel::<PeerEvent>();
        let (peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: request.ice_servers.clone(),
                relay_only: request.relay_only,
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

        let input = if wants_control {
            Some(
                InputDevices::create(source_w as i32, source_h as i32)
                    .map_err(|error| SessionError::new("input-unavailable", format!("{error:#}")))?,
            )
        } else {
            None
        };

        let inner = Arc::new(Inner {
            id: opaque_id(),
            generation,
            permissions: request.permissions,
            source,
            geometry,
            metrics,
            peer: Arc::new(peer),
            encoder: Mutex::new(encoder),
            input: Mutex::new(input),
            capture: Mutex::new(Some(capture)),
            layout: Mutex::new(
                Layout::from_environment()
                    .map_err(|error| SessionError::new("input", format!("no keyboard layout: {error:#}")))?,
            ),
            last_seq: Mutex::new(0),
            control_open: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            events: events.clone(),
        });

        let _ = events.send(SessionEvent::Description {
            generation,
            sdp: offer,
        });
        let _ = events.send(SessionEvent::State {
            capture: "consented",
            transport: String::from("new"),
            first_frame: false,
        });

        let pipeline = Arc::new(AtomicBool::new(true));
        spawn_pipeline(&inner, frame_rx, pipeline.clone());
        spawn_peer_events(&inner, peer_events_rx);
        spawn_lease(&inner, request.ttl.unwrap_or(Duration::from_secs(3600)));

        Ok(Self { inner, pipeline })
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

    pub fn first_frame_sent(&self) -> bool {
        self.metrics().encoded_frames > 0
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<()> {
        self.inner.peer.accept_answer(sdp).await
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
    pub fn read_clipboard(&self) -> std::result::Result<String, String> {
        if !self.inner.permissions.contains(&Permission::Clipboard) {
            return Err(String::from("this session has no clipboard permission"));
        }
        clipboard::read_or_explain()
    }

    pub fn write_clipboard(&self, text: &str) -> std::result::Result<(), String> {
        if !self.inner.permissions.contains(&Permission::Clipboard) {
            return Err(String::from("this session has no clipboard permission"));
        }
        clipboard::write(text).map_err(|error| format!("{error:#}"))
    }

    pub fn mark_closed_reason(&self) -> Option<String> {
        self.inner.revoked_reason()
    }

    /// Stop everything and release whatever input this session held. Idempotent.
    pub fn restore_source(&self) -> String {
        self.inner.source.source_type.clone().unwrap_or_else(|| String::from("monitor"))
    }

    pub async fn close(&self, reason: &str) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.pipeline.store(false, Ordering::SeqCst);
        // Release first, then tear down: a stuck modifier is the one failure the
        // user cannot undo by reconnecting.
        if let Ok(mut input) = self.inner.input.lock() {
            if let Some(devices) = input.as_mut() {
                devices.release_all();
            }
            *input = None;
        }
        let _ = self.inner.peer.send_control(
            &serde_json::to_string(&ControlReply::Revoked { reason })
                .unwrap_or_else(|_| String::from(r#"{"kind":"revoked","reason":"closed"}"#)),
        ).await;
        self.inner.peer.close().await;
        // Dropping the capture stops the PipeWire stream and joins its thread,
        // which is what releases the compositor's consent for this session. It
        // has to happen synchronously, not when the last handle happens to fall
        // out of scope, so the consumer can truthfully say the desktop stopped.
        let capture = self
            .inner
            .capture
            .lock()
            .ok()
            .and_then(|mut held| held.take());
        drop(capture);
        let _ = self.inner.events.send(SessionEvent::State {
            capture: "ended",
            transport: String::from("closed"),
            first_frame: false,
        });
    }
}

impl Inner {
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
    fn apply(&self, message: ControlMessage) {
        let seq = message.seq();
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
                    if let Some(devices) = input.as_mut() {
                        devices.release_all();
                    }
                }
                Ok(())
            }
            ControlMessage::ClipboardRead { request, .. } => {
                return self.clipboard_read(&request)
            }
            ControlMessage::ClipboardWrite { request, text, .. } => {
                return self.clipboard_write(&request, &text)
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
        action: impl FnOnce(&mut InputDevices) -> T,
    ) -> std::result::Result<T, (&'static str, String)> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| ("session", String::from("the input device is unavailable")))?;
        match input.as_mut() {
            Some(devices) => Ok(action(devices)),
            None => Err(("input-unavailable", String::from("no virtual input device"))),
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
        self.with_input(|devices| match phase {
            PointerPhase::Move => devices.move_absolute(x, y),
            PointerPhase::Down => {
                devices.move_absolute(x, y);
                devices.button(Button::from_number(button), true);
            }
            PointerPhase::Up => {
                devices.move_absolute(x, y);
                devices.button(Button::from_number(button), false);
            }
            PointerPhase::Cancel => devices.release_all(),
        })
    }

    fn wheel(&self, dx: i64, dy: i64, _seq: u64) -> std::result::Result<(), (&'static str, String)> {
        if dx.abs() > 100 || dy.abs() > 100 {
            return Err(("coordinates", String::from("scroll delta is out of range")));
        }
        self.with_input(|devices| devices.scroll(dx, dy))
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
                return self.with_input(|devices| devices.key(code, down));
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

        self.with_input(|devices| {
            if down {
                for modifier in &requested {
                    devices.key(*modifier, true);
                }
            }
            devices.key(stroke.code, down);
            if !down {
                for modifier in requested.iter().rev() {
                    devices.key(*modifier, false);
                }
            }
        })
    }

    fn text(&self, text: &str, seq: u64) -> std::result::Result<(), (&'static str, String)> {
        if text.len() > 4096 {
            return Err(("text-too-large", String::from("text exceeds 4096 bytes")));
        }
        let mut layout = self
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
        self.with_input(|devices| {
            for keystroke in plan {
                for stroke in keystroke {
                    let modifiers = stroke.modifiers();
                    for modifier in &modifiers {
                        devices.key(*modifier, true);
                    }
                    devices.key(stroke.code, true);
                    devices.key(stroke.code, false);
                    for modifier in modifiers.iter().rev() {
                        devices.key(*modifier, false);
                    }
                }
            }
        })
    }

    fn clipboard_read(&self, request: &str) {
        if !self.has(Permission::Clipboard) {
            self.reject(0, "permission", "this session has no clipboard permission");
            return;
        }
        let (text, error) = match clipboard::read_or_explain() {
            Ok(text) => (text, None),
            Err(reason) => (String::new(), Some(reason)),
        };
        let payload = ControlReply::Clipboard {
            request,
            text,
            error: error.as_deref(),
        };
        let _ = self.reply(&payload);
    }

    fn clipboard_write(&self, request: &str, text: &str) {
        if !self.has(Permission::Clipboard) {
            self.reject(0, "permission", "this session has no clipboard permission");
            return;
        }
        let failure = clipboard::write(text).err().map(|error| error.to_string());
        let payload = ControlReply::Clipboard {
            request,
            text: String::new(),
            error: failure.as_deref(),
        };
        let _ = self.reply(&payload);
    }

    fn encoded_size(&self) -> (usize, usize) {
        let encoded = &self.geometry["encoded"];
        (
            encoded["width"].as_u64().unwrap_or(0) as usize,
            encoded["height"].as_u64().unwrap_or(0) as usize,
        )
    }
}

/// Encode and send frames off the async runtime: libvpx blocks for the duration
/// of a frame and the send is asynchronous, so a plain thread driving the
/// runtime handle keeps both honest.
fn spawn_pipeline(inner: &Arc<Inner>, frame_rx: std_mpsc::Receiver<I420>, running: Arc<AtomicBool>) {
    let inner = inner.clone();
    let handle = tokio::runtime::Handle::current();
    std::thread::Builder::new()
        .name("desklink-encode".into())
        .spawn(move || {
            let mut last = Instant::now();
            let mut first_frame_sent = false;
            while let Ok(frame) = frame_rx.recv() {
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                let now = Instant::now();
                let duration = now
                    .duration_since(last)
                    .clamp(Duration::from_millis(8), Duration::from_millis(500));
                last = now;

                let packet = {
                    let mut encoder = match inner.encoder.lock() {
                        Ok(encoder) => encoder,
                        Err(_) => break,
                    };
                    encoder.encode(&frame, !first_frame_sent)
                };
                let packet = match packet {
                    Ok(packet) => packet,
                    Err(_) => {
                        if let Ok(mut m) = inner.metrics.lock() {
                            m.dropped_frames += 1;
                        }
                        continue;
                    }
                };
                first_frame_sent = true;
                if let Ok(mut m) = inner.metrics.lock() {
                    m.encoded_frames += 1;
                    m.encoded_bytes += packet.data.len() as u64;
                }
                let peer = inner.peer.clone();
                if handle
                    .block_on(peer.send_frame(packet.data, duration))
                    .is_err()
                {
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
            match event {
                PeerEvent::Candidate {
                    candidate,
                    sdp_mid,
                    sdp_m_line_index,
                } => {
                    let _ = inner.events.send(SessionEvent::Candidate {
                        generation: inner.generation,
                        candidate,
                        sdp_mid,
                        sdp_m_line_index,
                    });
                }
                PeerEvent::State(state) => {
                    let _ = inner.events.send(SessionEvent::State {
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
                        if let Some(devices) = input.as_mut() {
                            devices.release_all();
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
        if !inner.closed.load(Ordering::SeqCst) {
            let _ = inner
                .events
                .send(SessionEvent::Revoked {
                    reason: String::from("the session lease expired"),
                });
        }
    });
}

fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Fit a source into a box without upscaling, keeping even dimensions because
/// I420 chroma is subsampled.
pub fn fit(width: usize, height: usize, max_width: usize, max_height: usize) -> (usize, usize) {
    if max_width == 0 || max_height == 0 || (width <= max_width && height <= max_height) {
        return (width & !1, height & !1);
    }
    let scale = f64::min(max_width as f64 / width as f64, max_height as f64 / height as f64);
    (
        (((width as f64 * scale) as usize) & !1).max(2),
        (((height as f64 * scale) as usize) & !1).max(2),
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
}
