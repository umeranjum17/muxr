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
use rtc::interceptor::{
    Attribute, Interceptor, PacerBuilder, Packet, Registry, Slot, StreamInfo, TaggedPacket,
};
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::{MediaEngine, MIME_TYPE_VP9};
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::event::RTCPeerConnectionIceEvent;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::{RTCIceCandidateInit, RTCIceServer};
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtcp::receiver_report::ReceiverReport;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};
use rtc::rtp_transceiver::PayloadType;
use rtc::sansio::Protocol;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCPeerConnectionState,
};
use webrtc::runtime::default_runtime;

/// VP9 clock rate, fixed by RFC 9628.
const VP9_CLOCK_RATE: u32 = 90_000;

/// Payload type the engine offers VP9 on. Any value in the dynamic range works;
/// this one is the common convention and keeps packet captures readable.
pub const VP9_PAYLOAD_TYPE: PayloadType = 98;

fn vp9_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_VP9.to_owned(),
            clock_rate: VP9_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: Vec::new(),
        },
        payload_type: VP9_PAYLOAD_TYPE,
        ..Default::default()
    }
}

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
    /// The rate video packets are released at, in bits per second.
    pub pace_bps: f64,
}

/// What the pacer lets go back to back: a few dozen packets. A 4K key frame is
/// hundreds of packets, and released at once it overflows the receiver's
/// socket buffer, which loses the frame and draws another key frame request —
/// a loop that never shows a sharp picture.
const PACE_BURST_BITS: f64 = 256_000.0;

struct Handler {
    events: tokio::sync::mpsc::UnboundedSender<PeerEvent>,
    wants_keyframe: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
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
) {
    while let Some(event) = channel.poll().await {
        match event {
            DataChannelEvent::OnOpen => {
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
        let connected = matches!(state, RTCPeerConnectionState::Connected);
        if connected {
            self.wants_keyframe.store(true, Ordering::SeqCst);
        }
        self.connected.store(connected, Ordering::SeqCst);
        let _ = self.events.send(PeerEvent::State(state));
    }

    async fn on_data_channel(&self, _channel: Arc<dyn DataChannel>) {
        // The engine's own channel is served by `serve_control`. A channel the
        // remote opens is a second, unrelated stream and is deliberately not
        // adopted: two control channels would mean two ways to drive one
        // desktop, which is the ambiguity this protocol exists to avoid.
    }
}

/// Passes the application the inbound RTCP only it can act on: a receiver
/// asking for a key frame (PLI, FIR), and receiver reports, whose loss figure
/// sets how much the encoder may send. Everything else stays with the
/// interceptors that consume it (NACK, reports), and so does a copy of these:
/// this sits last, after all of them.
#[derive(Default)]
struct FeedbackForwarder {
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
}

fn is_feedback(packet: &Box<dyn rtc::rtcp::Packet>) -> bool {
    let packet = packet.as_any();
    packet.is::<PictureLossIndication>()
        || packet.is::<FullIntraRequest>()
        || packet.is::<ReceiverReport>()
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for FeedbackForwarder {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
            let wanted: Vec<Box<dyn rtc::rtcp::Packet>> = packets
                .iter()
                .filter(|packet| is_feedback(packet))
                .cloned()
                .collect();
            if wanted.is_empty() {
                return Ok(());
            }
            msg.message.packet = Packet::Rtcp(wanted);
            // Inbound RTCP ends at the chain's last stage unless marked for us.
            msg.message.add(Attribute::DeliverToApplication);
        }
        self.read.push_back(msg);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> std::result::Result<(), Self::Error> {
        self.write.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}

impl Interceptor for FeedbackForwarder {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}

/// Read the video sender's feedback until the peer closes it (by aborting this
/// task: the track's feedback channel outlives a closed peer): key frame
/// requests set `wants_keyframe`, receiver reports queue their loss fraction.
async fn serve_feedback(
    track: Arc<TrackLocalStaticRTP>,
    ssrc: u32,
    wants_keyframe: Arc<AtomicBool>,
    loss: Arc<Mutex<Vec<u8>>>,
) {
    loop {
        // The track is bound once the answer is applied; until then, and after
        // it is unbound, there is nothing to read.
        let Some(TrackLocalEvent::OnRtcpPacket(packets)) = track.poll().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        for packet in &packets {
            let packet = packet.as_any();
            if packet.is::<PictureLossIndication>() || packet.is::<FullIntraRequest>() {
                wants_keyframe.store(true, Ordering::SeqCst);
            } else if let Some(report) = packet.downcast_ref::<ReceiverReport>() {
                let mut queue = lock(&loss);
                queue.extend(
                    report
                        .reports
                        .iter()
                        .filter(|r| r.ssrc == ssrc)
                        .map(|r| r.fraction_lost),
                );
                let excess = queue.len().saturating_sub(64);
                queue.drain(..excess);
            }
        }
    }
}

/// The largest RTP packet the engine sends, headers included: under every
/// path MTU a desktop stream meets, DTLS/SRTP and TURN overhead included.
const RTP_MTU: usize = 1200;
const RTP_HEADER: usize = 12;

/// VP9 over RTP (RFC 9628) in flexible mode, one layer.
///
/// The payload descriptor is what a receiver builds its reference graph from,
/// so it has to tell the truth about each frame: a key frame is not
/// inter-predicted, and every other frame is, with the previous picture as its
/// reference. A descriptor that marks every frame as independent (as a generic
/// payloader does) makes the receiver drop the frames that are not really
/// independent and ask for key frames instead — the picture only moves on key
/// frames, which is exactly the failure a desktop cannot hide.
struct Vp9Packetizer {
    sequence: u16,
    picture_id: u16,
    timestamp_base: u32,
    started: Instant,
}

impl Vp9Packetizer {
    fn new() -> Self {
        Self {
            sequence: rand::random(),
            picture_id: rand::random::<u16>() & 0x7fff,
            timestamp_base: rand::random(),
            started: Instant::now(),
        }
    }

    fn packetize(
        &mut self,
        frame: &[u8],
        keyframe: bool,
        captured: Instant,
        ssrc: u32,
        payload_type: PayloadType,
    ) -> Vec<rtc::rtp::Packet> {
        // The RTP clock is the capture clock, so the receiver paces playout by
        // when frames were taken, not by when they happened to be sent.
        // Wraps, as the RTP clock does, rather than saturating after 13 hours.
        let ticks = (captured
            .saturating_duration_since(self.started)
            .as_secs_f64()
            * VP9_CLOCK_RATE as f64) as u64 as u32;
        let timestamp = self.timestamp_base.wrapping_add(ticks);
        let descriptor = if keyframe { 3 } else { 4 };
        let chunks: Vec<&[u8]> = frame.chunks(RTP_MTU - RTP_HEADER - descriptor).collect();
        let last = chunks.len().saturating_sub(1);
        let packets = chunks
            .into_iter()
            .enumerate()
            .map(|(index, chunk)| {
                let mut payload = bytes::BytesMut::with_capacity(descriptor + chunk.len());
                // I (picture id) and F (flexible mode) always; P for an inter
                // frame; B and E mark the frame's first and last packet.
                let mut first = 0x80 | 0x10;
                if !keyframe {
                    first |= 0x40;
                }
                if index == 0 {
                    first |= 0x08;
                }
                if index == last {
                    first |= 0x04;
                }
                payload.extend_from_slice(&[
                    first,
                    0x80 | (self.picture_id >> 8) as u8,
                    self.picture_id as u8,
                ]);
                if !keyframe {
                    // One reference: the previous picture (P_DIFF 1, N 0).
                    payload.extend_from_slice(&[1 << 1]);
                }
                payload.extend_from_slice(chunk);
                let sequence_number = self.sequence;
                self.sequence = self.sequence.wrapping_add(1);
                rtc::rtp::Packet {
                    header: rtc::rtp::Header {
                        version: 2,
                        marker: index == last,
                        payload_type,
                        sequence_number,
                        timestamp,
                        ssrc,
                        ..Default::default()
                    },
                    payload: payload.freeze(),
                }
            })
            .collect();
        self.picture_id = (self.picture_id + 1) & 0x7fff;
        packets
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
    /// True while the transport is connected: frames sent before it are lost.
    connected: Arc<AtomicBool>,
    track: Arc<TrackLocalStaticRTP>,
    packetizer: Mutex<Vp9Packetizer>,
    ssrc: u32,
    control: Arc<dyn DataChannel>,
    payload_type: PayloadType,
    /// Loss fractions (RFC 3550, /256) the far end reported, oldest first.
    loss: Arc<Mutex<Vec<u8>>>,
    feedback: tokio::task::JoinHandle<()>,
    /// The engine is the offerer, so a candidate can arrive before the answer
    /// that supplies its remote description; those are held here until it does.
    candidates: Mutex<PendingCandidates>,
}

#[derive(Default)]
struct PendingCandidates {
    ready: bool,
    held: Vec<RTCIceCandidateInit>,
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
        let video_codec = vp9_codec();
        media_engine
            .register_codec(video_codec.clone(), RtpCodecKind::Video)
            .context("failed to offer VP9")?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?
            .with(
                Slot::Pacer,
                PacerBuilder::new()
                    .with_target_bitrate(options.pace_bps)
                    .with_burst_bits(PACE_BURST_BITS)
                    .build(),
            )
            // Last, so every interceptor has seen the whole of the inbound RTCP.
            .with(Slot::from(14_000), FeedbackForwarder::default());

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
        let wants_keyframe = Arc::new(AtomicBool::new(true));
        let connected = Arc::new(AtomicBool::new(false));
        let control_events = events.clone();
        let peer = PeerConnectionBuilder::<std::net::SocketAddr>::new()
            .with_configuration(builder.build())
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_handler(Arc::new(Handler {
                events,
                wants_keyframe: wants_keyframe.clone(),
                connected: connected.clone(),
            }))
            .with_runtime(runtime)
            // An ephemeral port on every interface: ICE needs a socket to gather
            // candidates from, and the peer needs no fixed port because the
            // consumer's authenticated channel carries the candidates.
            .with_udp_addrs(vec![std::net::SocketAddr::from(([0, 0, 0, 0], 0))])
            .build()
            .await
            .context("failed to create the peer connection")?;
        let peer: Arc<dyn PeerConnection> = Arc::new(peer);

        let ssrc = rand::random::<u32>();
        let track: Arc<TrackLocalStaticRTP> =
            Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
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
            )));
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
        tokio::spawn(serve_control(Arc::clone(&control), control_events));

        let loss = Arc::new(Mutex::new(Vec::new()));
        let feedback = tokio::spawn(serve_feedback(
            Arc::clone(&track),
            ssrc,
            wants_keyframe.clone(),
            loss.clone(),
        ));

        let offer = peer.create_offer(None).await?;
        peer.set_local_description(offer.clone()).await?;

        Ok((
            Self {
                peer,
                wants_keyframe,
                connected,
                track,
                packetizer: Mutex::new(Vp9Packetizer::new()),
                ssrc,
                control,
                payload_type,
                loss,
                feedback,
                candidates: Mutex::new(PendingCandidates::default()),
            },
            offer.sdp,
        ))
    }

    pub async fn accept_answer(&self, sdp: String) -> Result<usize> {
        let answer = RTCSessionDescription::answer(sdp).context("the answer is not valid SDP")?;
        self.peer
            .set_remote_description(answer)
            .await
            .context("the peer refused the answer")?;
        let held = {
            let mut state = lock(&self.candidates);
            state.ready = true;
            std::mem::take(&mut state.held)
        };
        let mut applied = 0;
        for candidate in held {
            // Each was acknowledged when it arrived; a bad one must not turn the
            // answer into a failure.
            if self.peer.add_ice_candidate(candidate).await.is_ok() {
                applied += 1;
            }
        }
        Ok(applied)
    }

    pub async fn add_candidate(
        &self,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> Result<()> {
        let candidate = RTCIceCandidateInit {
            candidate,
            sdp_mid,
            sdp_mline_index: sdp_m_line_index,
            username_fragment: None,
            url: None,
        };
        {
            let mut state = lock(&self.candidates);
            if !state.ready {
                state.held.push(candidate);
                return Ok(());
            }
        }
        self.peer
            .add_ice_candidate(candidate)
            .await
            .context("the peer refused an ICE candidate")
    }

    /// Whether the transport is connected; a frame sent before it is lost.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Stand in for a connected transport, for a pipeline under test.
    #[cfg(test)]
    pub fn assume_connected(&self) {
        self.connected.store(true, Ordering::SeqCst);
    }

    /// Packetize one encoded frame and hand it to the track, paced by the
    /// interceptor chain. `captured` is when its picture was taken.
    pub async fn send_frame(&self, data: &[u8], keyframe: bool, captured: Instant) -> Result<()> {
        let packets = lock(&self.packetizer).packetize(
            data,
            keyframe,
            captured,
            self.ssrc,
            self.payload_type,
        );
        for packet in packets {
            self.track
                .write_rtp_with_extensions(packet, &[])
                .await
                .context("failed to hand a packet to the track")?;
        }
        Ok(())
    }

    /// Take the loss fractions reported since the last call, oldest first.
    pub fn take_loss_reports(&self) -> Vec<u8> {
        std::mem::take(&mut *lock(&self.loss))
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
        self.feedback.abort();
        let _ = self.control.close().await;
        let _ = self.peer.close().await;
    }
}

impl Drop for VideoPeer {
    fn drop(&mut self) {
        self.feedback.abort();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoopHandler;

    impl PeerConnectionEventHandler for NoopHandler {}

    async fn answerer(offer: &str) -> Arc<dyn PeerConnection> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_codec(vp9_codec(), RtpCodecKind::Video)
            .expect("VP9 registers");
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .expect("interceptors register");
        let peer = PeerConnectionBuilder::<std::net::SocketAddr>::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_runtime(default_runtime().expect("a runtime"))
            .with_handler(Arc::new(NoopHandler))
            .with_udp_addrs(vec![std::net::SocketAddr::from(([0, 0, 0, 0], 0))])
            .build()
            .await
            .expect("an answering peer");
        peer.set_remote_description(
            RTCSessionDescription::offer(offer.to_owned()).expect("a valid offer"),
        )
        .await
        .expect("the offer is accepted");
        Arc::new(peer)
    }

    #[tokio::test]
    async fn a_candidate_that_arrives_before_the_answer_is_not_refused() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (peer, _offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                pace_bps: 20_000_000.0,
            },
            events,
        )
        .await
        .expect("a peer connection");

        // The engine is the offerer, so the remote description only arrives with
        // the answer; this candidate must be held, not refused.
        peer.add_candidate(
            String::from("candidate:1 1 udp 2113937151 192.0.2.1 40000 typ host"),
            Some(String::from("0")),
            Some(0),
        )
        .await
        .expect("a candidate that arrives before the answer is buffered");
    }

    #[tokio::test]
    async fn held_candidates_reach_the_peer_when_the_answer_arrives() {
        let (events, _events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (peer, offer) = VideoPeer::offer(
            TransportOptions {
                ice_servers: Vec::new(),
                pace_bps: 20_000_000.0,
            },
            events,
        )
        .await
        .expect("a peer connection");

        let other = answerer(&offer).await;
        let answer = other.create_answer(None).await.expect("an answer");
        other
            .set_local_description(answer.clone())
            .await
            .expect("a local description");

        peer.add_candidate(
            String::from("candidate:1 1 udp 2113937151 192.0.2.1 40000 typ host"),
            Some(String::from("0")),
            Some(0),
        )
        .await
        .expect("a candidate before the answer is buffered");

        let applied = peer
            .accept_answer(answer.sdp)
            .await
            .expect("the answer is accepted");
        assert_eq!(applied, 1, "the held candidate must reach the peer");
    }
}
