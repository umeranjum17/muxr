---
title: Native voice transport
slug: native-voice-transport
status: tested
created: 2026-08-18
updated: 2026-08-28
owner: umer
links:
  - plugin-primitives
  - ../VOICE-SETUP.md
---

# Native voice transport

## Context

The original 0.1.x realtime voice path routed microphone and playback through the React Native JavaScript thread: LiveAudioStream emitted base64 chunks into JS, JS sent them over the encrypted relay to the host plugin, and provider PCM returned along the same path into an 8-slot native write queue. The 0.1.x reliability fixes (wake/Wi-Fi locks, mic-as-activity, consecutive reconnect budgets) made this survivable, but the structural weaknesses remain:

- Screen-off audio depends on the JS event loop staying scheduled.
- Every audio frame is base64 JSON through two WebSocket hops and a spawned plugin process.
- A stalled socket silently drops frames at the 512 KiB backpressure fence.
- There is no jitter buffer: bursts after a stall either queue-dump or chop.

## Target architecture

Provider credentials and product policy stay in muxr's host integration; `@byokit/realtime` owns provider sessions and signaling, and its provider-blind phone client owns the call: the WebRTC peer, reconnects and speech queueing. muxr supplies the phone client's stream, audio ports and app control. What changes is where the audio pump lives and how the phone connects:

1. **Two provider transport kinds share one engine interface.** The `@byokit/realtime` engines use either `pcm-relay` to exchange bounded PCM through the generic stream or `webrtc` for authenticated signaling and control; the kit's phone client owns the peer connection and sends media directly to the provider. Both sit behind the one selected product surface (`voice.stream`), so provider selection remains dynamic and exactly one runs.
2. **The kit client owns the WebRTC call.** muxr's microphone port starts the Android foreground service before the kit opens the WebRTC track; muxr supplies capture, playback, and routing through audio ports, while the kit owns the peer, media lifecycle, reconnects, and speech queueing. React Native coordinates app control and receives state, transcript, and error events.
3. **Credentials stay on the host.** The phone sends a bounded SDP offer through the existing encrypted stream. The host integration supplies credentials to the kit, which authenticates and returns the bounded SDP answer; provider credentials, account ids, private headers, and internal ids never reach the phone.

## Contract shape (public, bounded)

```
realtime.ready           → existing pcm-relay provider is ready with input/output rates
realtime.webrtc.start    → host requests a provider-neutral mobile offer
realtime.webrtc.offer    → bounded complete mobile SDP offer
realtime.webrtc.answer   → bounded provider SDP answer
realtime.state           → connecting | connected | thinking | speaking | ended(reason)
realtime.transcript      → { role, text }
```

No provider names, models, prompts, or tool vocabularies enter the provider-blind phone client. A replacement `@byokit/realtime` engine uses the same descriptor shape; the app binary needs no provider branch.

## Android work items

- `react-native-webrtc` supplies the platform peer connection, microphone track, and remote playback track behind the kit's `webRtcPeer`.
- muxr's microphone port starts the foreground service and waits for it before the kit calls `getUserMedia`; failure to start it aborts the session before the microphone opens.
- The kit's client closes every media track, data channel, peer connection, and realtime stream on stop; muxr's session state keeps one call at a time.
- PCM capture (VAD-aware) and native playback stay muxr's audio ports; the kit retains them across a stream reconnect.

## iOS note

The kit's `webRtcPeer` uses `react-native-webrtc` on iOS too; only Android requires foreground-service ordering.

## Verification

- Flow fixture: open a WebRTC provider stream, create and bound the SDP exchange, reach connected, exercise transcript and playback-track events, then stop and prove every track/peer closes.
- Provider security flow: owner-only Codex credentials, token/account binding, fixed OpenAI origins, memory-only bearer custody, bounded signaling, and redacted failures.
- Live subscription smoke: user transcript, agent transcript, inbound remote audio track, clean stop, and no credential or internal-id leakage.
- Existing PCM provider and product voice lifecycle checks remain green.

## Non-goals

- No provider credentials in the app binary or on the phone beyond a short-lived scoped token.
- No STT+LLM+TTS pipeline; speech-to-speech stays streaming-native.
- No provider-supplied audio code: the kit owns the provider-blind phone transport, and muxr's host integration supplies product policy and the descriptor to the kit.

## Revisions

- 2026-08-28: Implement two provider-neutral transport kinds: existing host-relayed PCM and mobile-owned WebRTC signaling for Codex Voice, with host-only OAuth custody.
