//! The WebRTC handoff: one VP9 video track out, one control data channel in.
//!
//! The engine is the offerer. The consumer's own authenticated channel carries
//! the SDP and ICE candidates to the client and brings the answer back; this
//! module never assumes anything about that channel, which is what keeps the
//! engine usable by an application that is not this one.
//!
//! Input and clipboard ride the session's data channel rather than the local
//! protocol. The channel is inside the DTLS/SRTP session the engine created for
//! one authorized grant, so it inherits that session's identity and dies with
//! it — a revoked session cannot be driven by a client that kept a socket open.

use anyhow::{Context, Result};
use bytes::Bytes;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use rtc::interceptor::Registry;
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::{MediaEngine, MIME_TYPE_VP9};
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::configuration::RTCIceTransportPolicy;
use rtc::peer_connection::event::RTCPeerConnectionIceEvent;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::{RTCIceCandidateInit, RTCIceServer};
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};
use rtc::rtp_transceiver::PayloadType;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCPeerConnectionState,
};
use webrtc::runtime::{default_runtime, Runtime};

/// VP9 clock rate, fixed by RFC 9628.
const VP9_CLOCK_RATE: u32 = 90_000;

/// Payload type the engine offers VP9 on. Any value in the dynamic range works;
/// this one is the common convention and keeps packet captures readable.
pub const VP9_PAYLOAD_TYPE: PayloadType = 98;

/// What the consumer needs to know about a live peer.
#[derive(Debug, Clone)]
pub enum PeerEvent {
    /// A local ICE candidate to forward to the client.
    Candidate {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    },
    /// The transport reached a new state.
    State(RTCPeerConnectionState),
    /// The control channel opened; input may now be accepted.
    ControlOpen,
    /// The control channel closed.
    ControlClosed,
    /// A control message arrived from the client.
    ControlMessage(String),
}

/// Transport settings the consumer chose for this session.
pub struct TransportOptions {
    pub ice_servers: Vec<(String, Option<String>, Option<String>)>,
    pub relay_only: bool,
}

struct Handler {
    events: tokio::sync::mpsc::UnboundedSender<PeerEvent>,
    wants_keyframe: Arc<AtomicBool>,
}

/// Watch the control channel the engine created.
///
/// The engine is the offerer, so it is the side that creates this channel, and
/// `on_data_channel` only fires for a channel the *remote* opened. Serving our
/// own channel is what makes the session two-way: a client that creates its own
/// channel with the same label gets an unrelated stream, its requests arrive
/// here and every reply lands on a channel nobody is reading.
async fn serve_control(
    channel: Arc<dyn DataChannel>,
    events: tokio::sync::mpsc::UnboundedSender<PeerEvent>,
    wants_keyframe: Arc<AtomicBool>,
) {
    while let Some(event) = channel.poll().await {
        match event {
            DataChannelEvent::OnOpen => {
                wants_keyframe.store(true, Ordering::SeqCst);
                let _ = events.send(PeerEvent::ControlOpen);
            }
            DataChannelEvent::OnMessage(message) => {
                if let Ok(text) = String::from_utf8(message.data.to_vec()) {
                    let _ = events.send(PeerEvent::ControlMessage(text));
                }
            }
            DataChannelEvent::OnClose => {
                let _ = events.send(PeerEvent::ControlClosed);
                break;
            }
            _ => {}
        }
    }
    let _ = events.send(PeerEvent::ControlClosed);
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            let _ = self.events.send(PeerEvent::Candidate {
                candidate: init.candidate,
                sdp_mid: init.sdp_mid,
                sdp_m_line_index: init.sdp_mline_index,
            });
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if matches!(state, RTCPeerConnectionState::Connected) {
            self.wants_keyframe.store(true, Ordering::SeqCst);
        }
        let _ = self.events.send(PeerEvent::State(state));
    }

    async fn on_data_channel(&self, _channel: Arc<dyn DataChannel>) {
        // The engine's own channel is served by `serve_control`. A channel the
        // remote opens is a second, unrelated stream and is deliberately not
        // adopted: two control channels would mean two ways to drive one
        // desktop, which is the ambiguity this protocol exists to avoid.
    }
}

pub struct VideoPeer {
    peer: Arc<dyn PeerConnection>,
    /// Set when the far end needs a fresh reference frame.
    ///
    /// The encoder's first frame is a key frame, but the far end is not
    /// receiving yet: ICE is still negotiating, and the decoder therefore starts
    /// mid-stream without the reference the following inter frames need. Asking
    /// for a key frame *when the transport connects* is what makes the picture
    /// appear at all; without it the browser reports frames received and zero
    /// frames decoded, which is exactly the failure this was.
    wants_keyframe: Arc<AtomicBool>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    control: Arc<dyn DataChannel>,
    payload_type: PayloadType,
    started: Instant,
    runtime: Arc<dyn Runtime>,
}

impl VideoPeer {
    /// Build the peer, add the video track and the control channel, and produce
    /// the offer for the consumer to carry to the client.
    pub async fn offer(
        options: TransportOptions,
        events: tokio::sync::mpsc::UnboundedSender<PeerEvent>,
    ) -> Result<(Self, String)> {
        let runtime = default_runtime().context("no WebRTC runtime is enabled")?;

        let mut media_engine = MediaEngine::default();
        let video_codec = RTCRtpCodecParameters {
            rtp_codec: RTCRtpCodec {
                mime_type: MIME_TYPE_VP9.to_owned(),
                clock_rate: VP9_CLOCK_RATE,
                channels: 0,
                sdp_fmtp_line: String::new(),
                rtcp_feedback: Vec::new(),
            },
            payload_type: VP9_PAYLOAD_TYPE,
            ..Default::default()
        };
        media_engine
            .register_codec(video_codec.clone(), RtpCodecKind::Video)
            .context("failed to offer VP9")?;
        let registry =
            register_default_interceptors(Registry::new(), &mut media_engine)?;

        let mut builder = RTCConfigurationBuilder::new();
        if !options.ice_servers.is_empty() {
            builder = builder.with_ice_servers(
                options
                    .ice_servers
                    .iter()
                    .map(|(url, username, credential)| RTCIceServer {
                        urls: vec![url.clone()],
                        username: username.clone().unwrap_or_default(),
                        credential: credential.clone().unwrap_or_default(),
                    })
                    .collect(),
            );
        }
        if options.relay_only {
            builder = builder.with_ice_transport_policy(
                RTCIceTransportPolicy::Relay,
            );
        }

        let wants_keyframe = Arc::new(AtomicBool::new(true));
        let control_events = events.clone();
        let peer = PeerConnectionBuilder::<std::net::SocketAddr>::new()
            .with_configuration(builder.build())
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_handler(Arc::new(Handler {
                events,
                wants_keyframe: wants_keyframe.clone(),
            }))
            .with_runtime(runtime.clone())
            // An ephemeral port on every interface: ICE needs a socket to gather
            // candidates from, and the peer needs no fixed port because the
            // consumer's authenticated channel carries the candidates.
            .with_udp_addrs(vec![std::net::SocketAddr::from(([0, 0, 0, 0], 0))])
            .build()
            .await
            .context("failed to create the peer connection")?;
        let peer: Arc<dyn PeerConnection> = Arc::new(peer);

        let ssrc = rand::random::<u32>();
        let track: Arc<TrackLocalStaticSample> = Arc::new(TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                String::from("desklink"),
                String::from("desktop"),
                String::from("desktop"),
                RtpCodecKind::Video,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(ssrc),
                        ..Default::default()
                    },
                    codec: video_codec.rtp_codec.clone(),
                    ..Default::default()
                }],
            ),
        )?);
        let sender = peer
            .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
            .await
            .context("failed to add the video track")?;
        let payload_type = sender
            .get_parameters()
            .await?
            .rtp_parameters
            .codecs
            .first()
            .map(|codec| codec.payload_type)
            .context("the video sender has no negotiated codec")?;

        let control = peer
            .create_data_channel("control", None)
            .await
            .context("failed to create the control channel")?;
        tokio::spawn(serve_control(
            Arc::clone(&control),
            control_events,
            wants_keyframe.clone(),
        ));

        let offer = peer.create_offer(None).await?;
        peer.set_local_description(offer.clone()).await?;

        Ok((
            Self {
                peer,
                wants_keyframe,
                track,
                ssrc,
                control,
                payload_type,
                started: Instant::now(),
                runtime,
            },
            offer.sdp,
        ))
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<()> {
        let answer = RTCSessionDescription::answer(sdp).context("the answer is not valid SDP")?;
        self.peer
            .set_remote_description(answer)
            .await
            .context("the peer refused the answer")
    }

    pub async fn add_candidate(
        &self,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> Result<()> {
        self.peer
            .add_ice_candidate(RTCIceCandidateInit {
                candidate,
                sdp_mid,
                sdp_mline_index: sdp_m_line_index,
                username_fragment: None,
                url: None,
            })
            .await
            .context("the peer refused an ICE candidate")
    }

    /// Hand one encoded frame to the track. The duration drives RTP timestamp
    /// pacing, so it is the frame's real display interval, not a fixed guess.
    pub async fn send_frame(&self, data: Vec<u8>, duration: Duration) -> Result<()> {
        self.track
            .sample_writer(self.ssrc, self.payload_type)
            .write_sample(&Sample {
                data: Bytes::from(data),
                timestamp: Instant::now(),
                duration,
                packet_timestamp: 0,
                prev_dropped_packets: 0,
                prev_padding_packets: 0,
            })
            .await
            .context("failed to hand a frame to the track")
    }

    pub fn payload_type(&self) -> PayloadType {
        self.payload_type
    }

    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    /// Take the pending "the far end needs a reference frame" request, if any.
    pub fn take_keyframe_request(&self) -> bool {
        self.wants_keyframe.swap(false, Ordering::SeqCst)
    }

    /// Send a control message back to the client (clipboard replies, revocation).
    pub async fn send_control(&self, message: &str) -> Result<()> {
        self.control
            .send_text(message)
            .await
            .context("the control channel is not writable")
    }

    pub async fn close(&self) {
        let _ = self.control.close().await;
        let _ = self.peer.close().await;
    }

    /// Sleep on the runtime the peer was built with, so timer behaviour belongs
    /// to one runtime rather than to whichever one a caller happens to use.
    pub async fn sleep(&self, duration: Duration) {
        self.runtime.sleep(duration).await;
    }
}
