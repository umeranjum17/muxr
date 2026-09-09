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

Realtime voice currently routes microphone and playback through the React Native JavaScript thread: LiveAudioStream emits base64 chunks into JS, JS sends them over the encrypted relay to the host plugin, and provider PCM returns along the same path into an 8-slot native write queue. The 0.1.x reliability fixes (wake/Wi-Fi locks, mic-as-activity, consecutive reconnect budgets) made this survivable, but the structural weaknesses remain:

- Screen-off audio depends on the JS event loop staying scheduled.
- Every audio frame is base64 JSON through two WebSocket hops and a spawned plugin process.
- A stalled socket silently drops frames at the 512 KiB backpressure fence.
- There is no jitter buffer: bursts after a stall either queue-dump or chop.

## Target architecture

Provider credentials and policy stay in host plugins; the phone kernel stays provider-blind. What changes is where the audio pump lives and how the phone connects:

1. **Two provider transport kinds share one capability.** Existing `pcm-relay` plugins keep owning provider sockets and exchanging bounded PCM through the generic stream. A `webrtc` plugin owns only authenticated signaling and control; the mobile kernel owns the peer connection and sends media directly to the provider. Both claim `voice.session`, so provider selection remains dynamic and exactly one runs.
2. **Native audio kernel owns WebRTC media.** The kernel starts the Android microphone foreground service before opening the WebRTC track, then owns capture, Opus, remote playback, interruption handling, and teardown. React Native coordinates bounded offer/answer signaling and receives only state, transcript, and error events.
3. **Credentials stay with the signaling plugin.** The phone sends a bounded SDP offer through the existing encrypted plugin stream. The host authenticates, verifies the destination, returns the bounded SDP answer, and never sends provider credentials, account ids, private headers, or internal ids to the phone.

## Contract shape (public, bounded)

```
realtime.ready           → existing pcm-relay provider is ready with input/output rates
realtime.webrtc.start    → host requests a provider-neutral mobile offer
realtime.webrtc.offer    → bounded complete mobile SDP offer
realtime.webrtc.answer   → bounded provider SDP answer
realtime.state           → connecting | connected | thinking | speaking | ended(reason)
realtime.transcript      → { role, text }
```

No provider names, models, prompts, or tool vocabularies in the kernel. A replacement provider plugin emits the same descriptor shape; the app binary needs no provider branch.

## Android work items

- `react-native-webrtc` supplies the platform peer connection, microphone track, and remote playback track behind a provider-neutral kernel module.
- The existing foreground service starts before `getUserMedia`; failure to start it aborts the session before the microphone opens.
- The kernel allows one active peer, binds app background/foreground and interruption cleanup, and closes every media track, data channel, peer connection, and plugin stream on stop.
- Existing PCM capture/playback and provider adapters remain byte-for-byte on their current transport path.

## iOS note

The same provider-neutral WebRTC kernel contract is used on iOS through `react-native-webrtc`; only Android requires foreground-service ordering.

## Verification

- Flow fixture: open a WebRTC provider stream, create and bound the SDP exchange, reach connected, exercise transcript and playback-track events, then stop and prove every track/peer closes.
- Provider security flow: owner-only Codex credentials, token/account binding, fixed OpenAI origins, memory-only bearer custody, bounded signaling, and redacted failures.
- Live subscription smoke: user transcript, agent transcript, inbound remote audio track, clean stop, and no credential or internal-id leakage.
- Existing PCM provider and voice plugin lifecycle checks remain green.

## Non-goals

- No provider credentials in the app binary or on the phone beyond a short-lived scoped token.
- No STT+LLM+TTS pipeline; speech-to-speech stays streaming-native.
- No plugin-supplied audio code: the transport is kernel-owned, plugins supply policy and the descriptor.

## Revisions

- 2026-08-28: Implement two provider-neutral transport kinds: existing host-relayed PCM and mobile-owned WebRTC signaling for Codex Voice, with host-only OAuth custody.
