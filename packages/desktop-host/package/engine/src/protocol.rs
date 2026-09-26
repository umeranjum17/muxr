//! Wire types for the local control protocol and for the session's control
//! channel. Documented in `docs/PROTOCOL.md`; this module is the definition.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 2;

/// A request from the consumer to the engine.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<u64>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A reply to one request. Exactly one of `result`/`error` is set.
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl ErrorBody {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

/// A notification the engine sends on its own.
#[derive(Debug, Serialize)]
pub struct Event {
    pub event: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Default, Deserialize)]
pub struct HelloParams {
    #[serde(default)]
    pub protocol: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    View,
    Control,
    Clipboard,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IceServerParam {
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// Which desktop to capture.
///
/// The portal is the default because on a Wayland desktop it is what carries the
/// user's consent. An explicit X display is the other supported backend: a
/// machine with no working screen-cast portal, a headless X server, or a remote
/// X session. Asking for one is a deployment choice, not a test switch.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRequest {
    Portal,
    X11 {
        #[serde(default)]
        display: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
pub struct OpenParams {
    /// Absent means "the portal, with the user's consent".
    #[serde(default)]
    pub source: Option<SourceRequest>,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default = "default_max_width")]
    pub max_width: usize,
    #[serde(default = "default_max_height")]
    pub max_height: usize,
    #[serde(default = "default_bitrate")]
    pub bitrate_kbps: u32,
    #[serde(default = "default_fps")]
    pub max_fps: u32,
    #[serde(default)]
    pub ice_servers: Vec<IceServerParam>,
    #[serde(default)]
    pub restore_token: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    /// Also listen for ICE over TCP on this computer's loopback, for a client
    /// whose only way here is a local forward (an SSH tunnel).
    #[serde(default)]
    pub loopback_tcp: bool,
}

/// The encode box when the consumer names none: a desktop's own pixels up to
/// 4K, because a phone zooms into the picture and text has to survive that.
fn default_max_width() -> usize {
    3840
}
fn default_max_height() -> usize {
    2160
}
/// Zero asks the engine to size the rate to the encoded surface.
fn default_bitrate() -> u32 {
    0
}
fn default_fps() -> u32 {
    30
}

#[derive(Debug, Deserialize)]
pub struct SessionRef {
    pub session_id: String,
    #[serde(default)]
    pub generation: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct DescriptionParams {
    pub session_id: String,
    #[serde(default)]
    pub generation: Option<u64>,
    pub description: RtcDescription,
}

#[derive(Debug, Deserialize)]
pub struct RtcDescription {
    #[serde(rename = "type")]
    pub kind: String,
    pub sdp: String,
}

#[derive(Debug, Deserialize)]
pub struct CandidateParams {
    pub session_id: String,
    #[serde(default)]
    pub generation: Option<u64>,
    pub candidate: String,
    #[serde(default)]
    pub sdp_mid: Option<String>,
    #[serde(default, rename = "sdpMLineIndex", alias = "sdp_m_line_index")]
    pub sdp_m_line_index: Option<u16>,
}

#[derive(Debug, Deserialize)]
pub struct ClipboardParams {
    pub session_id: String,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// Messages the client sends on the session's control channel.
///
/// `seq` is the client's own ordering. The engine refuses a repeat or a lower
/// value rather than re-applying an action, so a replayed frame cannot move the
/// pointer twice.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlMessage {
    Pointer {
        phase: PointerPhase,
        x: i64,
        y: i64,
        #[serde(default = "left_button")]
        button: i64,
        #[serde(default)]
        seq: u64,
    },
    /// Detents; fractions scroll smoothly where the desktop supports it.
    Wheel {
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
        #[serde(default)]
        seq: u64,
    },
    Key {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        character: Option<String>,
        down: bool,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default)]
        seq: u64,
    },
    Text {
        text: String,
        #[serde(default)]
        seq: u64,
    },
    ReleaseAll {
        #[serde(default)]
        seq: u64,
    },
    ClipboardRead {
        request: String,
        #[serde(default)]
        seq: u64,
    },
    ClipboardWrite {
        request: String,
        text: String,
        #[serde(default)]
        seq: u64,
    },
}

fn left_button() -> i64 {
    1
}

impl ControlMessage {
    pub fn seq(&self) -> u64 {
        match self {
            Self::Pointer { seq, .. }
            | Self::Wheel { seq, .. }
            | Self::Key { seq, .. }
            | Self::Text { seq, .. }
            | Self::ReleaseAll { seq }
            | Self::ClipboardRead { seq, .. }
            | Self::ClipboardWrite { seq, .. } => *seq,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerPhase {
    Move,
    Down,
    Up,
    Cancel,
}

/// Messages the engine sends back on the control channel.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlReply<'a> {
    Hello {
        protocol: u32,
        geometry: serde_json::Value,
    },
    Ack {
        seq: u64,
    },
    Rejected {
        seq: u64,
        code: &'a str,
        message: &'a str,
    },
    Clipboard {
        request: &'a str,
        text: String,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
    Revoked {
        reason: &'a str,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pointer_message_round_trips_with_its_sequence() {
        let parsed: ControlMessage =
            serde_json::from_str(r#"{"kind":"pointer","phase":"down","x":10,"y":20,"seq":3}"#)
                .unwrap();
        match parsed {
            ControlMessage::Pointer {
                phase,
                x,
                y,
                seq,
                button,
            } => {
                assert!(matches!(phase, PointerPhase::Down));
                assert_eq!((x, y, seq, button), (10, 20, 3, 1));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn an_unknown_action_is_refused_rather_than_ignored() {
        assert!(serde_json::from_str::<ControlMessage>(r#"{"kind":"teleport"}"#).is_err());
    }

    #[test]
    fn open_defaults_keep_the_desktops_own_pixels_up_to_4k() {
        let params: OpenParams =
            serde_json::from_str(r#"{"permissions":["view","control"]}"#).unwrap();
        assert_eq!(params.max_width, 3840);
        assert_eq!(params.max_height, 2160);
        assert_eq!(
            params.bitrate_kbps, 0,
            "the engine sizes the rate to the surface"
        );
        assert_eq!(params.max_fps, 30);
    }
}
