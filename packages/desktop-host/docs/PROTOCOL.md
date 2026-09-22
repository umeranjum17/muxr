# desklink local control protocol (v2)

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

Every engine notification carries the `sessionId` it belongs to, so a consumer
that has served more than one session in a process can attribute it to the
right one.

Request parameters use the engine's own snake_case names (`session_id`,
`max_width`, `sdp_mid`, …); the examples below are the wire names to send.

## Handshake

```jsonc
{"id":1,"method":"hello","params":{"protocol":2}}
```

Result:

```jsonc
{"protocol":2,"engine":"desklink-host/0.1.0","platform":"linux", /* the rest of Capabilities */ }
```

The consumer must send `hello` first, and a version the engine does not speak is
refused with `error.code = "unsupported-protocol"`. Until a supported `hello`
arrives, every other request is refused the same way; `capabilities` and
`shutdown` are the two that answer without a handshake.

## Capabilities

```jsonc
{"id":2,"method":"capabilities"}
```

```jsonc
{
  "protocol": 2,
  "engine": "desklink-host/0.1.0",
  "platform": "linux",
  "session": {"kind": "wayland"},
  "x11": {"available": true, "size": [2560, 1440]},
  "capture": {
    "mechanism": "portal-screencast+pipewire",
    "backends": ["portal-screencast+pipewire", "x11-root"],
    "formats": ["bgrx", "bgra", "rgbx", "rgba"],
    "cursor": "embedded",
    "audio": false
  },
  "encode": {"codecs": ["vp9"], "hardware": false},
  "input": {
    "mechanism": "inputtino/uinput",
    "pointer": true, "wheel": true, "keyboard": true,
    "text": ["latin1", "layout-reachable"],
    "layout": "us",
    "unavailable_reason": null,
    "grant": "granted"
  },
  "clipboard": {"read": true, "write": true, "mime": ["text/plain;charset=utf-8"], "maxBytes": 262144}
}
```

`input.mechanism` names the build's portal input path, `inputtino/uinput`,
where the engine creates its own virtual devices. A session opened against an X
display applies input through XTest instead, where the X server applies the
events and nothing the engine does can reach another session's keyboard.
`input.layout` is the keymap the engine compiled for typing, taken from the
session's `XKB_DEFAULT_*` variables and `us` on `evdev`/`pc105` when it exports
none. It is not yet the compositor's live layout, so a mismatch with the
desktop is visible here rather than silent. `capture.backends` lists what this
build has, not what this machine can necessarily use.

Every field describes what this process can *actually* do right now, not what the
platform might do. `input.unavailable_reason` and `input.grant` (the string
`"granted"`, or `"missing-device-access"`) are the honest degraded modes: without
kernel input access the engine still captures and reports `input` as unavailable,
and the consumer shows a view-only surface. It never substitutes another product
and never asks for privileges on its own.

`capabilities` is safe to call before any consent has been given and must not
trigger a capture request.

## Sources

```jsonc
{"id":3,"method":"sources","params":{"refresh":false}}
```

```jsonc
{"granted":true,
 "sources":[{"id":"<opaque>","kind":"monitor","width":2560,"height":1440,"origin":{"x":0,"y":0}}]}
```

The portal does not enumerate sources until the user grants one, so an
un-granted engine returns an empty list and `granted:false`. A source `id` is
opaque and local to this process's lifetime — it is not a portable identity.

## Opening a session

```jsonc
{"id":4,"method":"session.open","params":{
  "source": {"kind":"portal"},          // or {"kind":"x11","display":":99"}
  "permissions": ["view","control","clipboard"],
  "max_width": 1280, "max_height": 800, // encode box; never upscales
  "bitrate_kbps": 4000,
  "max_fps": 30,
  "ice_servers": [{"urls":["stun:..."],"username":null,"credential":null}],
  "relay_only": false,                  // true keeps ICE to relay candidates
  "restore_token": null,                // from a previous session.restoreToken
  "ttl_seconds": 3600                  // session lease; default 3600
}}
```

Result:

```jsonc
{"sessionId":"<opaque>","generation":1,
 "source":{"kind":"monitor","width":2560,"height":1440,"origin":{"x":0,"y":0}},
 "geometry":{"source":{"width":2560,"height":1440},
             "encoded":{"width":1280,"height":720},
             "origin":{"x":0,"y":0}}}
```

`source` selects the desktop. `portal` (or absent) asks the compositor for a
screen cast, which is the only path that carries a Wayland user's consent;
`x11` reads a named X display's root window and applies input through XTest. The
choice is capability-based rather than a table of desktops: the portal when there
is one, an X display otherwise. It is normally the *consumer's* decision, because
a client is not in a position to know which of the two a machine can offer.

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
{"id":5,"method":"session.description","params":{"session_id":"…","generation":1,
  "description":{"type":"answer","sdp":"v=0\r\n…"}}}
```

```jsonc
{"event":"session.candidate","params":{"sessionId":"…","generation":1,
  "candidate":"candidate:…","sdpMid":"0","sdpMLineIndex":0}}
{"id":6,"method":"session.candidate","params":{"session_id":"…","generation":1,
  "candidate":"candidate:…","sdp_mid":"0","sdp_m_line_index":0}}
```

A candidate that arrives before the remote description is buffered, not dropped.

### State

```jsonc
{"event":"session.state","params":{"sessionId":"…",
  "capture":"streaming",              // consented|streaming|ended
  "transport":"connected",            // new|connecting|connected|failed|closed
  "firstFrame":true}}                 // false until a frame has been encoded
```

The `geometry` a client maps touch against is the one `session.open` returned,
and the one the control channel's `hello` repeats. A source or scale change
starts a new `generation`; input carrying an older generation is refused, never
remapped.

```jsonc
{"event":"session.restoreToken","params":{"sessionId":"…","token":"…"}}
```

The portal handed back a restore token for a later `session.open`. A consumer
that does not persist one can ignore this notification.

```jsonc
{"event":"session.revoked","params":{"sessionId":"…","reason":"…"}}
```

The session ended on the engine's side; there is nothing further to drain.

Metrics are a request, not a notification:

```jsonc
{"id":7,"method":"session.metrics","params":{"session_id":"…"}}
```

```jsonc
{"id":7,"result":{"captured_frames":812,"dropped_frames":3,"encoded_frames":809,
  "encoded_bytes":12345678,"input_applied":44,"input_rejected":0}}
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
| `key` | `name` (a named key or modifier) or `character` (one character), `down`, `modifiers` | the engine maps `character` through the layout it compiled (`input.layout` in `capabilities`), and refuses a character that layout cannot produce |
| `text` | `text` (≤ 4096 bytes) | applied as real key events, not as a clipboard paste |
| `release_all` | — | explicit safety net; the engine also does this on close and on channel loss |
| `clipboard_read` / `clipboard_write` | `request` (echoed back), `text` | explicit, on user action; never polled |

The engine answers on the same channel:

```jsonc
{"kind":"hello","protocol":2,"geometry":{…}}     // once, when the channel opens
{"kind":"ack","seq":44}
{"kind":"rejected","seq":44,"code":"coordinates","message":"(9000,4) is outside the 1280x720 surface"}
{"kind":"clipboard","request":"…","text":"…","truncated":false}   // an empty "text" with "error" when the read failed
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
characters the compiled layout can actually produce; anything else is refused
with `text-unsupported` and the honest workaround is the explicit clipboard.

## Clipboard over the local protocol

The control channel is the path a controller uses (above). A co-located consumer
— a test harness, or a script on the same machine — can use the local protocol
instead; both reach the same clipboard:

```jsonc
{"id":9,"method":"session.clipboard.read","params":{"session_id":"…"}}
{"id":9,"result":{"text":"…","truncated":false}}
{"id":10,"method":"session.clipboard.write","params":{"session_id":"…","text":"…"}}
{"id":10,"result":{"written":true}}
```

Refused with `error.code = "clipboard"` when the session lacks `clipboard`, or
when the desktop's clipboard has no text. A read is bounded by
`capabilities.clipboard.maxBytes`; when the desktop's text is longer, `truncated`
is true and the text is cut on a character boundary, so the returned text is
still valid.

## Close

```jsonc
{"id":12,"method":"session.close","params":{"session_id":"…"}}
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
