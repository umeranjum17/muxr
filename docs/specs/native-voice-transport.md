---
title: Native voice transport
slug: native-voice-transport
status: planned
created: 2026-08-18
updated: 2026-08-18
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

1. **Provider plugin mints a session, not a stream.** The plugin authenticates to its provider (xAI today) and returns a provider-neutral *session descriptor*: transport kind, endpoint, short-lived client token, input/output rates, and capability flags. No permanent credentials leave the host.
2. **Native audio kernel owns the call.** An Android module (Kotlin) owns the microphone, Opus/PCM encode, the socket/WebRTC data channel, jitter buffer, playback, reconnect, and the foreground-service lifecycle. React Native receives only state, transcript, and error events.
3. **Direct when safe, gateway otherwise.** Providers with ephemeral client credentials (WebRTC or token-scoped WS) connect phone→provider directly. Providers without them terminate at a plugin-side gateway that bridges the same wire format — the phone side is identical either way.

## Contract shape (public, bounded)

```
realtime.session.open  → { transport: 'webrtc' | 'ws', url, token, inputRate, outputRate, providerFlags }
realtime.state         → connecting | connected | thinking | speaking | reconnecting | ended(reason)
realtime.transcript    → { role, text }
realtime.metrics       → { droppedIn, droppedOut, jitterMs, reconnects }   (bounded counters only)
```

No provider names, models, prompts, or tool vocabularies in the kernel. A replacement provider plugin emits the same descriptor shape; the app binary needs no provider branch.

## Android work items

- `voice-overlay` gains a `RealtimeTransport` Kotlin class: AudioRecord + AudioTrack, a 200–400 ms adaptive jitter buffer, and WS/WebRTC send/receive with bounded queues and drop counters.
- The foreground service already holds wake/Wi-Fi locks (v0.1.5+); the transport lives inside it so Doze cannot stall the pump.
- Reconnect policy: consecutive-budget resets after 30 s stable (already the JS behavior), plus jitter-buffer drain on rejoin instead of queue-dump.
- JS keeps: UI state, transcripts, mute, hang-up, and descriptor fetch via the existing plugin stream/RPC.

## iOS note

The same module boundary is the iOS plan: an `AVAudioEngine` transport behind the identical descriptor contract. Building it is part of the iOS runway, not a fork.

## Verification

- Loopback fixture provider in the suite: connect, talk, force socket drop, reconnect, assert no queue-dump artifacts and bounded drop counters.
- Screen-off soak: 10-minute call with screen off survives without state corruption or audio gaps beyond the jitter budget.
- The existing `checkVoicePlugin.mjs` lifecycle keeps passing; provider plugin behavior unchanged.

## Non-goals

- No provider credentials in the app binary or on the phone beyond a short-lived scoped token.
- No STT+LLM+TTS pipeline; speech-to-speech stays streaming-native.
- No plugin-supplied audio code: the transport is kernel-owned, plugins supply policy and the descriptor.
