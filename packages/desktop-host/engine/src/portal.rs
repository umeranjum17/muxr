//! Portal (XDG Desktop Portal ScreenCast) session negotiation.
//!
//! The portal is the only capture path this engine asks the compositor for: it
//! is what carries the user's consent, works across Wayland compositors, and
//! hands back a PipeWire remote that [`crate::capture`] consumes. No
//! compositor-private protocol is used.

use anyhow::{Context, Result};
use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
use ashpd::desktop::PersistMode;
use ashpd::enumflags2::BitFlags;
use std::os::fd::OwnedFd;

/// What the portal gave us: a PipeWire remote plus the identity of the selected
/// source. `width`/`height` are the source's logical size in the compositor's
/// own scale; `position` is its origin in the desktop layout.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SelectedSource {
    pub node_id: u32,
    pub width: i32,
    pub height: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<(i32, i32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    /// Absolute origin of the selected source in the desktop layout. Reported
    /// for diagnostics and for geometry consumers only: input is applied in the
    /// source's own pixels, and nothing here is added to a converted
    /// coordinate.
    pub origin_x: i32,
    pub origin_y: i32,
}

pub struct PortalSession {
    pub fd: OwnedFd,
    pub source: SelectedSource,
    pub restore_token: Option<String>,
}

/// Ask the portal for a screen cast session.
///
/// `restore_token` is a token from an earlier session; supplying it lets a
/// backend skip the picker when its policy allows it. The returned token must be
/// persisted by the consumer and is single-use.
pub async fn open(restore_token: Option<&str>) -> Result<PortalSession> {
    let proxy = Screencast::new()
        .await
        .context("compositor has no ScreenCast portal")?;

    if proxy
        .available_source_types()
        .await
        .is_ok_and(|types| !types.contains(SourceType::Monitor))
    {
        anyhow::bail!("ScreenCast portal advertises no monitor source");
    }

    let session = proxy
        .create_session()
        .await
        .context("ScreenCast.CreateSession failed")?;

    proxy
        .select_sources(
            &session,
            // The cursor is part of the picture the user drives; hiding it would
            // make precise placement impossible.
            CursorMode::Embedded,
            BitFlags::from(SourceType::Monitor),
            false,
            restore_token,
            // Request a durable grant, not one tied to this engine process.
            // The portal still owns consent and may decline persistence.
            PersistMode::ExplicitlyRevoked,
        )
        .await
        .context("ScreenCast.SelectSources failed")?
        .response()
        .context("ScreenCast.SelectSources was cancelled")?;

    // `Start` is what the compositor uses to present its consent UI.
    let streams = proxy
        .start(&session, None)
        .await
        .context("ScreenCast.Start failed")?
        .response()
        .context("screen capture was not granted")?;

    let stream = streams
        .streams()
        .first()
        .context("portal returned no capture stream")?;

    let (width, height) = stream.size().context("portal stream has no logical size")?;
    let position = stream.position();

    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .context("OpenPipeWireRemote failed")?;

    Ok(PortalSession {
        fd,
        source: SelectedSource {
            node_id: stream.pipe_wire_node_id(),
            width,
            height,
            position,
            source_type: stream.source_type().map(|t| format!("{t:?}")),
            origin_x: position.map(|(x, _)| x).unwrap_or(0),
            origin_y: position.map(|(_, y)| y).unwrap_or(0),
        },
        restore_token: streams.restore_token().map(str::to_owned),
    })
}
