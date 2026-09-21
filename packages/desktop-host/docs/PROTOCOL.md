# desklink local control protocol (v1)

The host engine is a per-user, on-demand process. A consumer that already owns
the user's session starts it and talks to it over an inherited private channel —
the engine never opens a public listener, never runs as root, and never installs
a service.

This document is the engine's whole public surface. It contains no application
concepts: no accounts, no chat, no machine ids, no pane ids.

## Starting the engine

```
desklink-host serve
```

The consumer spawns this process, keeps its `stdin`/`stdout` and parses them as
newline-delimited JSON. `stdout` carries protocol messages only; diagnostics go
to `stderr`. One JSON object per line, no length prefix, UTF-8.

Why stdio rather than a socket: the consumer already holds the process, so the
channel inherits the consumer's own access control (same uid, same session, no
filesystem permission to get wrong) and no second authorization mechanism has to
exist. A consumer that wants a socket can wrap this process.

Cancellation is by closing the consumer's end. The engine treats EOF on `stdin`
exactly like `shutdown`: it releases held input, stops capture, closes peers, and
exits.

## Message shape

Requests (consumer → engine) carry an `id`; responses repeat it. Engine-initiated
notifications carry `event` and never an `id`.

```jsonc
// request
{"id": 7, "method": "session.open", "params": { }}
// success
{"id": 7, "result": { }}
// failure — the request was refused or could not run
{"id": 7, "error": {"code": "unsupported-source", "message": "human readable"}}
// notification
{"event": "session.state", "params": { }}
```

`error.code` is a stable machine token; `message` is for logs, not for display.

## Handshake

```jsonc
{"id":1,"method":"hello","params":{"protocol":1,"client":"<free-form label>"}}
```

Result:

```jsonc
{"protocol":1,"engine":"desklink-host/0.1.0","capabilities":{ /* see below */ }}
```

The consumer must send `hello` first. A version the engine does not speak is
refused with `error.code = "unsupported-protocol"`; the engine then exits rather
than guessing.

## Capabilities

```jsonc
{"id":2,"method":"capabilities"}
```

```jsonc
{
  "protocol": 1,
  "platform": "linux",
  "session": {"kind": "wayland"},
  "capture": {
    "mechanism": "portal-screencast+pipewire",
    "formats": ["bgrx", "rgba", "nv12"],
    "cursor": "embedded",
    "audio": false
  },
  "encode": {"codecs": ["vp9"], "hardware": false, "maxWidth": 2560, "maxHeight": 1440},
  "input": {
    "mechanism": "inputtino/uinput",
    "pointer": true, "wheel": true, "keyboard": true,
    "text": ["ascii", "keysym"],
    "unavailable_reason": null
  },
  "clipboard": {"read": true, "write": true, "mime": ["text/plain;charset=utf-8"]},
  "grant": {"requires": "uinput-access", "state": "granted"}
}
```

Every field describes what this process can *actually* do right now, not what the
platform might do. `input.unavailable_reason` and `grant.state` are the honest
degraded modes: without kernel input access the engine still captures and reports
`input` as unavailable, and the consumer shows a view-only surface. It never
substitutes another product and never asks for privileges on its own.

`capabilities` is safe to call before any consent has been given and must not
trigger a capture request.

## Sources

```jsonc
{"id":3,"method":"sources","params":{"refresh":false}}
```

```jsonc
{"sources":[{"id":"<opaque>","kind":"monitor","name":"DP-1","width":2560,"height":1440,"scale":1.5,"origin":{"x":0,"y":0}}]}
```

The portal does not enumerate sources until the user grants one, so an
un-granted engine returns an empty list and `granted:false`. A source `id` is
opaque and local to this process's lifetime — it is not a portable identity.

## Opening a session

```jsonc
{"id":4,"method":"session.open","params":{
  "source": null,                       // null = let the portal/consent UI choose
  "permissions": ["view","control","clipboard"],
  "maxWidth": 1280, "maxHeight": 800,   // encode box; never upscales
  "bitrateKbps": 4000,
  "maxFps": 30,
  "iceServers": [{"urls":["stun:..."],"username":null,"credential":null}],
  "iceTransportPolicy": "all",          // "all" | "relay"
  "restoreToken": null                  // from a previous session.restoreToken
}}
```

Result:

```jsonc
{"sessionId":"<opaque>","generation":1,
 "source":{"kind":"monitor","width":2560,"height":1440,"origin":{"x":0,"y":0}},
 "video":{"width":1280,"height":720,"codec":"vp9","payloadType":98},
 "permissions":["view","control","clipboard"]}
```

`permissions` are the engine's authority for this session. The engine enforces
them on every input and clipboard action and never infers them from a source, a
peer or an SDP. `control` without a working input backend is refused at
`session.open` with `error.code = "input-unavailable"` — the consumer must ask
for `view` explicitly instead.

`session.open` is where the capture request happens, which is where the user's
consent appears. It is not implicit and it is not retried silently.

### Description and ICE exchange

The engine is the media offerer; the consumer's authenticated signaling carries
the SDP and candidates to the client and brings back the answer.

```jsonc
{"event":"session.description","params":{"sessionId":"…","generation":1,
  "description":{"type":"offer","sdp":"v=0\r\n…"}}}
```

```jsonc
{"id":5,"method":"session.description","params":{"sessionId":"…","generation":1,
  "description":{"type":"answer","sdp":"v=0\r\n…"}}}
```

```jsonc
{"event":"session.candidate","params":{"sessionId":"…","generation":1,
  "candidate":"candidate:…","sdpMid":"0","sdpMLineIndex":0}}
{"id":6,"method":"session.candidate","params":{"sessionId":"…","generation":1,
  "candidate":"candidate:…","sdpMid":"0","sdpMLineIndex":0}}
```

A candidate that arrives before the remote description is buffered, not dropped.

### State

```jsonc
{"event":"session.state","params":{"sessionId":"…","generation":1,
  "capture":"streaming",              // idle|consented|streaming|ended
  "transport":"connected",            // new|connecting|connected|failed|closed
  "firstFrameAt":1789000000123,       // ms since engine start, null until presented
  "geometry":{"source":{"width":2560,"height":1440},
              "encoded":{"width":1280,"height":720},
              "origin":{"x":0,"y":0}},
  "degraded":null}}                   // e.g. "source-unreadable: dmabuf"
```

`geometry` is what the client maps touch against: the encoded surface plus the
source's origin in the desktop layout. A source or scale change starts a new
`generation`; input carrying an older generation is refused, never remapped.

```jsonc
{"event":"session.metrics","params":{"sessionId":"…","generation":1,
  "capturedFrames":812,"droppedFrames":3,"encodedFrames":809,
  "encodedBytes":12345678,"inputApplied":44,"inputRejected":0,
  "rttMs":41,"route":"direct","codec":"vp9"}}
```

## Input and clipboard: the session's control channel

Input does **not** travel the local protocol. It rides the WebRTC data channel
the engine creates for the session, which is inside the DTLS/SRTP session that
was opened for one authorized grant: it inherits that session's identity and dies
with it, so a client that kept a socket open cannot keep driving a session that
was revoked, and the consumer's request path never carries a pointer move.

The engine is the offerer and creates a data channel labelled `control`. Messages
are JSON, one per message:

```jsonc
{"kind":"pointer","phase":"down","x":812,"y":433,"button":1,"seq":44}
{"kind":"wheel","dx":0,"dy":2,"seq":45}
{"kind":"key","name":"Enter","down":true,"modifiers":["Control"],"seq":46}
{"kind":"text","text":"hello","seq":47}
{"kind":"release_all"}
{"kind":"clipboard_read","request":"<opaque>","seq":48}
{"kind":"clipboard_write","request":"<opaque>","text":"…","seq":49}
```

| kind | fields | notes |
|---|---|---|
| `pointer` | `phase`: `move`\|`down`\|`up`\|`cancel`, `x`, `y`, `button` (default 1) | `x`/`y` are integers in the **encoded surface's** own pixels, i.e. `geometry.encoded` |
| `wheel` | `dx`, `dy` (integer detents) | |
| `key` | `name` (a named key or modifier) or `character` (one character), `down`, `modifiers` | the engine maps `character` through the desktop's **active layout**, and refuses a character that layout cannot produce |
| `text` | `text` (≤ 4096 bytes) | applied as real key events, not as a clipboard paste |
| `release_all` | — | explicit safety net; the engine also does this on close and on channel loss |
| `clipboard_read` / `clipboard_write` | `request` (echoed back), `text` | explicit, on user action; never polled |

The engine answers on the same channel:

```jsonc
{"kind":"hello","protocol":1,"geometry":{…}}     // once, when the channel opens
{"kind":"ack","seq":44}
{"kind":"rejected","seq":44,"code":"coordinates","message":"(9000,4) is outside the 1280x720 surface"}
{"kind":"clipboard","request":"…","text":"…"}     // or "error" instead of "text"
{"kind":"revoked","reason":"…"}
```

Refusal codes: `permission`, `session`, `input-replay`, `coordinates`,
`text-too-large`, `text-unsupported`, `input-unavailable`, `operation`.

`seq` is monotonic per session. A repeat or a lower value is refused with
`input-replay` and **no side effect**, so a replayed message cannot move the
pointer twice. Validation, permission and ordering checks all run before any
physical effect.

The engine holds its own pressed-key/button state. `close`, `release_all`,
control-channel loss and process exit all synthesize releases for exactly the
keys and buttons this session pressed, so a dropped connection cannot leave a
modifier stuck down on the desktop. `input.text` in `capabilities` states the
characters this desktop's layout can actually produce; anything else is refused
with `text-unsupported` and the honest workaround is the explicit clipboard.

## Clipboard over the local protocol

The control channel is the path a controller uses (above). A co-located consumer
— a test harness, or a script on the same machine — can use the local protocol
instead; both reach the same clipboard:

```jsonc
{"id":9,"method":"session.clipboard.read","params":{"sessionId":"…"}}
{"id":9,"result":{"text":"…","truncated":false}}
{"id":10,"method":"session.clipboard.write","params":{"sessionId":"…","text":"…"}}
{"id":10,"result":{"written":true}}
```

Refused with `error.code = "clipboard"` when the session lacks `clipboard`, or
when the desktop's clipboard has no text. The size bound is reported in
`capabilities` as `clipboard.maxBytes`.

## Renew, and close

```jsonc
{"id":11,"method":"session.renew","params":{"sessionId":"…","generation":1,"ttlSeconds":600}}
```

Bumps the session's lease without touching capture, transport or input state.

```jsonc
{"id":12,"method":"session.close","params":{"sessionId":"…"}}
```

Closes are idempotent and terminal for that session: held input is released,
capture stops, the peer is closed and the consent-bearing PipeWire stream is
dropped. A `stop` for a generation that is no longer current is a no-op and
never closes a newer session.

```jsonc
{"id":13,"method":"shutdown"}
```

Closes every session and exits.

## What the engine deliberately does not do

- It does not decide *who* the user is. It trusts the consumer's local
  permission decision and enforces the resulting scope; there is no second
  account, token or pairing ceremony.
- It does not open ports, register a service, install udev rules, join groups or
  raise capabilities. Kernel input access is a separate, explicit, guided step
  (`desklink-host setup-input` reports what is missing; it does not change it).
- It does not carry audio. A phone watching and driving a desktop needs pixels
  and input; audio is a different product decision.
- It does not arbitrate between two controllers. One session, one controller.
- It does not auto-reconnect with authority it no longer holds: after a lease
  expiry or owner disconnect it requires a fresh `session.open`.
