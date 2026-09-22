//! `desklink-host` — per-user, on-demand desktop capture, encode and input engine.
//!
//! The public surface is the versioned local control protocol documented in
//! `docs/PROTOCOL.md`. It knows nothing about the application that consumes it:
//! no accounts, no chat, no machine identity, no pane. A consumer starts this
//! process, owns its stdin/stdout, and carries the SDP/ICE the engine produces
//! over whatever authenticated channel it already has.

mod capture;
mod clipboard;
mod convert;
mod encoder;
mod input;
mod keymap;
mod peer;
mod portal;
mod protocol;
mod session;
mod x11;

use anyhow::Result;
use protocol::{ErrorBody, Event, Request, Response};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc as tokio_mpsc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("error: cannot start the runtime: {error}");
            std::process::exit(1);
        }
    };
    let code = match command {
        "version" | "--version" | "-V" => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            0
        }
        "capabilities" => {
            println!("{}", serde_json::to_string_pretty(&session::capabilities()).unwrap());
            0
        }
        "serve" => report(runtime.block_on(serve())),
        "capture-probe" => report(runtime.block_on(probe(
            args.get(1).and_then(|value| value.parse().ok()),
            args.get(2).map(String::as_str),
        ))),
        "setup-input" => {
            print_input_setup();
            0
        }
        "help" | "--help" | "-h" => {
            print_help();
            0
        }
        other => {
            eprintln!("unknown command: {other}");
            print_help();
            2
        }
    };
    std::process::exit(code);
}

fn report(result: Result<()>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("error: {error:#}");
            1
        }
    }
}

fn print_help() {
    println!(
        "desklink-host {}

USAGE:
  desklink-host serve            speak the local control protocol on stdin/stdout
  desklink-host capabilities     print what this machine can do right now
  desklink-host capture-probe [seconds] [display]
                                 capture frames and report the stream; with a
                                 display argument it reads that X display's root
                                 window instead of asking the portal
  desklink-host setup-input      explain the one-time input-access step (changes nothing)
  desklink-host version

The engine is started by a consumer that already owns the user's session. It
never listens on a public interface, never runs as root, and never installs
anything. See docs/PROTOCOL.md for the protocol.",
        env!("CARGO_PKG_VERSION")
    );
}

/// Deliberately does not perform the change. Kernel input access is a privileged
/// decision, so the engine explains it and stops; the user runs the command.
fn print_input_setup() {
    match input::probe() {
        Ok(()) => {
            println!("Kernel input access is already available on this machine.");
            println!("Nothing to do: the engine will create its own virtual pointer and keyboard");
            println!("for the duration of a session and destroy them when it ends.");
        }
        Err(unavailable) => {
            println!("Kernel input access is NOT available: {}", unavailable.reason);
            println!();
            println!("This engine injects pointer and keyboard events by creating its own virtual");
            println!("devices through the kernel's uinput interface. That is whole-desktop control");
            println!("of the logged-in session, not control of one application, and it is not");
            println!("something an installation is allowed to grant for you.");
            println!();
            println!("A one-time, narrowly scoped rule for the uinput device alone is:");
            println!();
            println!("  # /etc/udev/rules.d/70-desklink-uinput.rules");
            println!("  KERNEL==\"uinput\", SUBSYSTEM==\"misc\", MODE=\"0660\", GROUP=\"desklink-input\"");
            println!();
            println!("  sudo groupadd --system desklink-input");
            println!("  sudo usermod -aG desklink-input \"$USER\"");
            println!("  sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=uinput");
            println!();
            println!("That is deliberately narrower than joining the `input` group, which would also");
            println!("expose the physical keyboards and mice. Group membership usually needs a fresh");
            println!("login before this process sees it.");
            println!();
            println!("To undo it: remove the rule, remove the user from the group, reload the rules.");
            println!("Without it the engine still captures the desktop and reports view-only.");
        }
    }
}

/// Start the portal session, capture a few frames, and print what actually
/// arrived. This is the diagnostic to run when the picture does not appear.
async fn probe(seconds: Option<u64>, display: Option<&str>) -> Result<()> {
    let seconds = seconds.unwrap_or(3);
    match display {
        Some(display) => probe_x11(display, seconds),
        None => probe_portal(seconds).await,
    }
}

/// Read a named X display's root window for a few seconds. The frame shape is
/// reported as a coarse checksum so a flat or unreadable screen is visible.
fn probe_x11(display: &str, seconds: u64) -> Result<()> {
    let mut desktop = crate::x11::X11Desktop::connect(Some(display))?;
    let (width, height) = desktop.screen_size();
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    let mut frames = 0u64;
    let mut shapes = std::collections::BTreeSet::new();
    let mut encoded = (0usize, 0usize);
    while std::time::Instant::now() < deadline {
        let frame = desktop.capture(0, 0)?;
        encoded = (frame.width, frame.height);
        shapes.insert(frame_shape(&frame));
        frames += 1;
        std::thread::sleep(Duration::from_millis(33));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "source": { "kind": "x11-root", "display": display, "width": width, "height": height },
            "frames": frames,
            "encoded": { "width": encoded.0, "height": encoded.1 },
            "distinct_frames": shapes.len(),
        }))?
    );
    if frames == 0 {
        anyhow::bail!("no frames arrived from {display}");
    }
    Ok(())
}

/// A cheap fingerprint of a frame, enough to tell "the screen changed" from
/// "the screen is one flat colour".
fn frame_shape(frame: &crate::convert::I420) -> u64 {
    frame
        .y_plane()
        .iter()
        .enumerate()
        .fold(0u64, |accumulator, (index, byte)| {
            accumulator
                .wrapping_mul(31)
                .wrapping_add((*byte as u64) ^ (index as u64 & 0xff))
        })
}

async fn probe_portal(seconds: u64) -> Result<()> {
    let portal = portal::open(None).await?;
    eprintln!("portal source: {:?}", portal.source);

    let (tx, rx) = std_mpsc::channel();
    let capture = capture::start(
        portal,
        0,
        0,
        Box::new(move |frame, seq| {
            let _ = tx.send((frame.width, frame.height, seq));
        }),
    )?;

    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    let mut seen = 0u64;
    let mut last = (0usize, 0usize);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok((width, height, _)) => {
                seen += 1;
                last = (width, height);
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "frames": seen,
            "frames_counted": capture.frame_count(),
            "dropped": capture.dropped(),
            "encoded": { "width": last.0, "height": last.1 },
            "geometry": capture.geometry(),
        }))?
    );
    if seen == 0 {
        anyhow::bail!("no frames arrived; the compositor did not deliver a readable buffer");
    }
    Ok(())
}

/// The local control protocol loop.
async fn serve() -> Result<()> {
    let (out_tx, mut out_rx) = tokio_mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });

    let (events_tx, mut events_rx) = tokio_mpsc::unbounded_channel::<session::Notice>();
    {
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            while let Some(event) = events_rx.recv().await {
                if let Some(line) = render_event(event) {
                    if out_tx.send(line).is_err() {
                        break;
                    }
                }
            }
        });
    }

    let mut current: Option<session::Session> = None;
    let mut hello_seen = false;
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(line) {
            Ok(request) => request,
            Err(error) => {
                // A malformed request with no id cannot be answered in place;
                // report it and keep the channel usable.
                let _ = out_tx.send(
                    serde_json::json!({
                        "error": { "code": "malformed", "message": error.to_string() }
                    })
                    .to_string(),
                );
                continue;
            }
        };
        let id = request.id;
        let outcome = dispatch(&request, &mut hello_seen, &mut current, &events_tx).await;
        if let Some(id) = id {
            let payload = match outcome {
                Ok(result) => serde_json::to_string(&Response {
                    id,
                    result: Some(result),
                    error: None,
                }),
                Err(error) => serde_json::to_string(&Response {
                    id,
                    result: None,
                    error: Some(error),
                }),
            };
            if let Ok(payload) = payload {
                if out_tx.send(payload).is_err() {
                    break;
                }
            }
        }
        if let Some(session) = &current {
            if session.mark_closed_reason().is_some() {
                current = None;
            }
        }
    }

    if let Some(session) = current.take() {
        session.close("the consumer disconnected").await;
    }
    let _ = out_tx.send(String::new()).ok();
    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

fn render_event(notice: session::Notice) -> Option<String> {
    let session::Notice { session_id, event } = notice;
    let (name, params) = match event {
        session::SessionEvent::Description { generation, sdp } => (
            "session.description",
            serde_json::json!({ "sessionId": session_id, "generation": generation, "description": { "type": "offer", "sdp": sdp } }),
        ),
        session::SessionEvent::Candidate {
            generation,
            candidate,
            sdp_mid,
            sdp_m_line_index,
        } => (
            "session.candidate",
            serde_json::json!({
                "sessionId": session_id,
                "generation": generation,
                "candidate": candidate,
                "sdpMid": sdp_mid,
                "sdpMLineIndex": sdp_m_line_index,
            }),
        ),
        session::SessionEvent::State {
            capture,
            transport,
            first_frame,
        } => (
            "session.state",
            serde_json::json!({ "sessionId": session_id, "capture": capture, "transport": transport, "firstFrame": first_frame }),
        ),
        session::SessionEvent::RestoreToken(token) => {
            ("session.restoreToken", serde_json::json!({ "sessionId": session_id, "token": token }))
        }
        session::SessionEvent::Revoked { reason } => {
            ("session.revoked", serde_json::json!({ "sessionId": session_id, "reason": reason }))
        }
    };
    serde_json::to_string(&Event {
        event: name.to_owned(),
        params,
    })
    .ok()
}

async fn dispatch(
    request: &Request,
    hello_seen: &mut bool,
    current: &mut Option<session::Session>,
    events: &tokio_mpsc::UnboundedSender<session::Notice>,
) -> std::result::Result<serde_json::Value, ErrorBody> {
    match request.method.as_str() {
        "hello" => {
            let params: protocol::HelloParams = serde_json::from_value(request.params.clone())
                .map_err(|error| ErrorBody::new("malformed", error.to_string()))?;
            if params.protocol != protocol::PROTOCOL_VERSION {
                return Err(ErrorBody::new(
                    "unsupported-protocol",
                    format!(
                        "this engine speaks protocol {} but the consumer asked for {}",
                        protocol::PROTOCOL_VERSION,
                        params.protocol
                    ),
                ));
            }
            *hello_seen = true;
            Ok(session::capabilities())
        }
        "capabilities" => Ok(session::capabilities()),
        "shutdown" => {
            if let Some(session) = current.take() {
                session.close("the consumer shut the engine down").await;
            }
            std::process::exit(0);
        }
        _ if !*hello_seen => Err(ErrorBody::new(
            "unsupported-protocol",
            "send `hello` with the protocol version before anything else",
        )),
        "session.open" => {
            if let Some(existing) = current.take() {
                existing.close("replaced by a new session").await;
            }
            let params: protocol::OpenParams = serde_json::from_value(request.params.clone())
                .map_err(|error| ErrorBody::new("malformed", error.to_string()))?;
            let open = session::OpenRequest {
                source: params.source,
                permissions: params.permissions,
                max_width: params.max_width,
                max_height: params.max_height,
                bitrate_kbps: params.bitrate_kbps,
                max_fps: params.max_fps,
                relay_only: params.relay_only,
                restore_token: params.restore_token,
                ttl: params.ttl_seconds.map(Duration::from_secs),
                ice_servers: params
                    .ice_servers
                    .into_iter()
                    .filter_map(|server| {
                        server
                            .urls
                            .first()
                            .map(|url| (url.clone(), server.username, server.credential))
                    })
                    .collect(),
            };
            let session = session::Session::open(open, events.clone())
                .await
                .map_err(|error| ErrorBody::new(error.code, error.message))?;
            let result = serde_json::json!({
                "sessionId": session.id(),
                "generation": session.generation(),
                "source": {
                    "kind": session.restore_source(),
                    "width": session.source().width,
                    "height": session.source().height,
                    "origin": { "x": session.source().origin_x, "y": session.source().origin_y },
                },
                "geometry": session.geometry(),
            });
            *current = Some(session);
            Ok(result)
        }
        "sources" => Ok(serde_json::json!({
            "granted": current.is_some(),
            "sources": current.as_ref().map(|session| serde_json::json!([{
                "id": session.source().node_id.to_string(),
                "kind": session.restore_source(),
                "width": session.source().width,
                "height": session.source().height,
                "origin": { "x": session.source().origin_x, "y": session.source().origin_y },
            }])).unwrap_or_else(|| serde_json::json!([])),
        })),
        "session.description" => {
            let session = require_session(current)?;
            let params: protocol::DescriptionParams =
                serde_json::from_value(request.params.clone())
                    .map_err(|error| ErrorBody::new("malformed", error.to_string()))?;
            check_session(session, &params.session_id, params.generation)?;
            if params.description.kind != "answer" {
                return Err(ErrorBody::new(
                    "operation",
                    "the engine is the offerer; send an answer",
                ));
            }
            session
                .accept_answer(params.description.sdp)
                .await
                .map_err(|error| ErrorBody::new("transport", format!("{error:#}")))?;
            Ok(serde_json::json!({ "accepted": true }))
        }
        "session.candidate" => {
            let session = require_session(current)?;
            let params: protocol::CandidateParams = serde_json::from_value(request.params.clone())
                .map_err(|error| ErrorBody::new("malformed", error.to_string()))?;
            check_session(session, &params.session_id, params.generation)?;
            session
                .add_candidate(params.candidate, params.sdp_mid, params.sdp_m_line_index)
                .await
                .map_err(|error| ErrorBody::new("transport", format!("{error:#}")))?;
            Ok(serde_json::json!({ "accepted": true }))
        }
        "session.clipboard.read" => {
            let session = require_session(current)?;
            let params: protocol::ClipboardParams = serde_json::from_value(request.params.clone())
                .map_err(|error| ErrorBody::new("malformed", error.to_string()))?;
            check_session(session, &params.session_id, None)?;
            let (text, truncated) = session
                .read_clipboard()
                .await
                .map_err(|reason| ErrorBody::new("clipboard", reason))?;
            Ok(serde_json::json!({ "text": text, "truncated": truncated }))
        }
        "session.clipboard.write" => {
            let session = require_session(current)?;
            let params: protocol::ClipboardParams = serde_json::from_value(request.params.clone())
                .map_err(|error| ErrorBody::new("malformed", error.to_string()))?;
            check_session(session, &params.session_id, None)?;
            session
                .write_clipboard(params.text.unwrap_or_default())
                .await
                .map_err(|reason| ErrorBody::new("clipboard", reason))?;
            Ok(serde_json::json!({ "written": true }))
        }
        "session.metrics" => {
            let session = require_session(current)?;
            Ok(serde_json::to_value(session.metrics()).unwrap_or(serde_json::Value::Null))
        }
        "session.close" => {
            let session = require_session(current)?;
            let params: protocol::SessionRef = serde_json::from_value(request.params.clone())
                .map_err(|error| ErrorBody::new("malformed", error.to_string()))?;
            check_session(session, &params.session_id, params.generation)?;
            let session = current.take().expect("checked above");
            session.close("the consumer closed the session").await;
            Ok(serde_json::json!({ "closed": true }))
        }
        other => Err(ErrorBody::new(
            "operation",
            format!("unknown method {other}"),
        )),
    }
}

fn require_session(
    current: &mut Option<session::Session>,
) -> std::result::Result<&mut session::Session, ErrorBody> {
    current
        .as_mut()
        .ok_or_else(|| ErrorBody::new("session", "no session is open"))
}

/// A late message for a session that has already ended must not revive it, and a
/// message for a different session must not reach this one.
fn check_session(
    session: &session::Session,
    id: &str,
    generation: Option<u64>,
) -> std::result::Result<(), ErrorBody> {
    if session.id() != id {
        return Err(ErrorBody::new("session", "that session id is not open"));
    }
    if let Some(generation) = generation {
        if generation != session.generation() {
            return Err(ErrorBody::new("generation", "that generation has ended"));
        }
    }
    if session.mark_closed_reason().is_some() {
        return Err(ErrorBody::new("session", "that session has ended"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_consumer_speaking_another_protocol_version_is_refused() {
        let mut hello_seen = false;
        let mut current = None;
        let (events, _received) = tokio_mpsc::unbounded_channel();
        let request = Request {
            id: Some(1),
            method: String::from("hello"),
            params: serde_json::json!({ "protocol": 99, "client": "test" }),
        };
        let error = dispatch(&request, &mut hello_seen, &mut current, &events)
            .await
            .unwrap_err();
        assert_eq!(error.code, "unsupported-protocol");
        assert!(!hello_seen, "a refused handshake must not open the gate");
    }

    #[tokio::test]
    async fn the_state_notification_carries_exactly_what_the_document_promises() {
        let line = render_event(session::Notice {
            session_id: String::from("session-1"),
            event: session::SessionEvent::State {
                capture: "streaming",
                transport: String::from("connected"),
                first_frame: true,
            },
        })
        .expect("a state event is renderable");
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["event"], "session.state");
        assert_eq!(
            parsed["params"],
            serde_json::json!({
                "sessionId": "session-1",
                "capture": "streaming",
                "transport": "connected",
                "firstFrame": true
            })
        );
    }
}
