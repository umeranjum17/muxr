---
title: Browser and Code web surfaces
slug: browser-code-surfaces
status: in-progress
created: 2026-09-09
updated: 2026-09-12
owner: umer
links:
  - ../decisions/0005-pi-like-extension-runtime.md
  - cross-machine-collaboration
---

# Browser and Code web surfaces

## Status on the PWA lineage (2026-09-12)

This spec now tracks the port onto `feat/pwa-primary-channel` (base
`8eac274c`), where the browser app is the first-class runtime. What is in:

- Host offers, local broker, leases (approval-snapshot identity, exact offer
  generation, live session, 1 s standing sweep, revocation closing live
  connections), the `muxr browser|code|surface` CLI and both plugin
  manifests -- unchanged in shape from Slice 2A.
- Browser on web: a leased offer resolves through `preview.lease`, attaches
  the existing encrypted v1 preview channel, and the existing preview
  service worker serves the page into an opaque-origin sandboxed iframe under
  the PWA's own origin. No loopback listener, no cookie install, no private
  127/8 origin, no admission gateway: none of those exist or are needed in a
  browser tab. Reload is the update mechanism; HMR/WebSockets do not ride the
  request bridge.
- Browser on native: the same lease path over the existing native loopback
  bridge (Slice 0 posture: shared `127.0.0.1` cookie jar, no admission).
- Direct HTTPS: an iframe on web with a labelled external-tab action for
  sites that refuse framing; the hardened WebView on native.
- Code stays review/navigation-first: `code open`/`code diff` route to the
  native Files/Changes viewer.
- Offers broadcast on the session channel (no per-recipient sealing); an
  offer carries no credential and acting on one needs a control grant and a
  lease issued to that exact device.

Deliberately not ported: v2 authenticated framing and credits, the admission
gateway, private origins and cookie admission, the Kotlin surface chooser,
the developer Web Surface route.

## Frozen interfaces for the two Browser routes (2026-09-12, Code descoped)

Browser is delivered through two explicit routes and nothing else: **Preview**
(the app's own DOM over host-terminated HTTPS, with its WebSockets, cookies,
Fast Refresh and overlays) and **Agent browser** (one broker-owned Chromium
session streamed over WebRTC, with an enforceable human handover for sign-in).
Code stays as it is and is not extended. These names are the integration
contract between the surface lane and the PWA lane; UI text maps from them.

**Preview.** `preview.lease` / `preview.renew` / `preview.release` keep their
authority semantics. `preview.bootstrap(lease)` returns, privately inside the
E2EE result, the approved HTTPS `origin` the host allocated for the endpoint,
the endpoint `generation`, the app `path`, and a one-use POST `bootstrap`
(`path`, `body`, `expiresAt`). The renderer submits the body to `origin +
bootstrap.path` exactly once; the gateway answers a Secure, HttpOnly, host-only
`__Host-` admission cookie and redirects into the app. A second submission, an
expired body, or one from another lease is refused; renewal extends admission
server-side; a fresh bootstrap is needed only when the cookie is gone. The
renderer never receives a tunnel key or a shared machine credential. Endpoint
identity is project + provider + process generation: a reused local address
never silently becomes another app. `browser-local` offers stay under
`surface.browser.open`, resolve the registered project's actual development URL
on the host, and never take a phone-selected port.

**Agent browser.** A `browser-session` offer requires
`surface.browser.control-host-session` and carries an opaque `session`
handle, a safe `site` hostname and the host-resolved `context` -- never a port,
URL userinfo/query/fragment, or provider id. The browser service is the sole
authority; the host relays. Device requests: `browser.session.status`
(`generation`, `state`, `owner`, `site`, `navigation`, `reason?`,
`expiresAt`), `browser.session.take`, `pause`, `resume`, `return` (each with
`session`, `expectedGeneration`, idempotent `command`), and
`browser.session.signal` (`session`, `generation`, sealed `message`). States:
`agent-driving`, `waiting-for-you`, `taking-control`, `you-control`,
`giving-back`, `paused`, `checking`, `ended`. Private signaling (SDP with
authenticated fingerprints, ICE, input permits, field focus) is sealed under the
separately pinned **browser-service grant** (existing signed/X25519 device-grant
machinery, per-device roots; the PWA lane owns its storage and pairing, the
surface lane owns its use through `packages/crypto/src/e2ee/{application,domain}/browserSession.ts`),
so nothing private is readable with the shared session root, and it expires
with the device grant and the session.

**Agent side.** `muxr browser session {open,navigate,snapshot,click,fill,scroll,help}`
addresses the session by logical name through the approved host-session
capability; `help` only requests human assistance and never conveys
credentials. `muxr browser open` remains the ordinary app-preview command.
Agent automation uses this provider from session creation; it gets semantic
operations only -- no raw CDP, evaluation, cookie/storage export,
interception, init scripts, recording, extension management, file access or
debug endpoints.

Ownership of files across the two lanes is recorded in the direction brief and
not duplicated here.

## Context

Browser and Code are currently drawn as Kitty graphics inside a terminal pane. That path cannot give a phone real DOM input, selection, accessibility, scrolling, uploads, or a software keyboard that behaves. It also spends a PTY and a graphics protocol on something a WebView already does natively.

muxr already ships nearly all of the substrate a real web surface needs:

- device loopback TCP bridge: `apps/mobile/sources/preview/infrastructure/previewBridge.ts`
- tunnel lifecycle: `apps/mobile/sources/preview/infrastructure/attachPreviewTunnel.ts`
- host loopback forwarder: `apps/host/src/requests/infrastructure/preview.ts`
- multiplexed opaque preview frames: `packages/contract/src/control-plane/infrastructure/preview.ts`
- `react-native-webview`, already a dependency
- a secure WebView configuration precedent: `apps/mobile/sources/app/(app)/web-view.tsx`
- a separate non-Kitty host-browser takeover: `apps/mobile/sources/takeover/**`

## Decision

Stop using Kitty graphics as the Browser or Code product path.

Build one compiled mobile **Web Surface** container and expose the Browser capability over it:

- **Browser**: a real `react-native-webview` browser for ordinary HTTPS and tunneled host-local web apps.
- **Code**: proposed as a pinned `code-server` over the same surface. **Killed at Slice 0** on 2026-09-10; see below. Nothing replaces it, and native Files, Changes and History stay as they are.

The current agent-browser takeover stays exactly as it is -- a separate
host-browser path outside the terminal with no new CDP or pixel-stream
scope. This slice adds no labeled takeover entry and no emitter for
`surface.browser.control-host-session`; host-profile sessions keep using
the existing takeover route.

No Browser or Code failure may fall back to Kitty or a graphical terminal.

## Product UX

### Browser

- Native top bar: Back, Forward, Reload/Stop, visible origin, Share, Return to agent.
- Native WebView scrolling, zoom, text selection, keyboard, accessibility, uploads and downloads.
- HTTPS URLs load directly with phone-owned cookies.
- Registered host-local HTTP apps load through the encrypted tunnel, including same-origin WebSockets, SSE and HMR.
- Host-profile sessions open through the existing takeover route and are labeled; phone and host cookie stores never pretend to be the same.
- Unsupported schemes, file URLs, popups and silent external navigation fail closed or need an explicit system-browser confirmation.

### Code (killed at Slice 0)

Code was to be a muxr-managed pinned `code-server` on the live worktree, opened through the same surface. Slice 0 proved the transport and the workbench but failed the approved product criterion on a real Android build:

- finger drag cannot extend a selection across lines; long-press opens Monaco's own menu and offers no native selection handles (Monaco issue 4860 is open, and code-server PR 7841 states that only pen or stylus drag selects);
- the software keyboard stopped opening reliably for focused Monaco carets;
- repairing either needs a Monaco or workbench fork, or an equivalent custom editing layer, which the approved boundary forbids.

So there is no Code Surface, no code-server supervisor, no Code capability or launcher, no key-emulation layer, and no fallback of any kind. Editing on the phone stays with the existing native Files, Changes and History. Browser proceeds on its own; Kitty does not come back either way.

## First-class entry points only

There are no live users of the legacy Terminal Browser / Tode launcher packages, so nothing is migrated, aliased, or impersonated. The only entry points are the first-class muxr Browser and Code plugins (`muxr.browser`, `muxr.code`), their Tools entries, and the `muxr browser|code|surface` CLI. Tools entries open a Surface offer through the local broker and never create a terminal pane. Legacy identities (`zenbu-labs.*`, `terminal-browser`, `tode`, `terminal-code`, `open-split`) appear nowhere in the kernel, the package, or the skill.

New native semantics are provider-neutral capabilities: `surface.browser.open`, `surface.browser.control-host-session`, `surface.code.open`. Resolution order is explicit selection, saved selection, then sole enabled claimant. Missing or ambiguous providers fail closed. There is no terminal fallback.

## Activation and skill behavior

```text
muxr surface capabilities --json
muxr surface browser <https-or-local-url>
muxr surface list
muxr surface close <name>
```

The muxr skill gains a `surfaces` topic. With muxr available and `HERDR_PANE_ID` present, agents use the Surface commands instead of terminal graphics. `HERDR_PANE_ID` is only a context hint, resolved against live Herdr state and Device authority. No relay token, tunnel key, IDE password, internal id or capability secret enters agent output or environment. A launch creates or updates a visible Surface card and only foregrounds when the controlling device has enabled that preference.

## Required transport and security work

1. **Authenticated framing**: bind direction, connection id, flag and monotonic sequence to every encrypted frame including close; reject replay and remapping before opening upstream connections.
2. **Backpressure**: bounded connection count, per-connection and aggregate queue ceilings, socket pause/resume and drain across device, relay and host. Never drop arbitrary TCP bytes; close explicitly on overflow.
3. **Endpoint leases**: the phone attaches to a host-registered endpoint lease, not an arbitrary caller-selected port. Bind machine, Device, surface kind, plugin snapshot, worktree, endpoint and expiry. Revocation closes live connections.
4. **Loopback authentication**: code-server authentication stays enabled; bootstrap credentials travel only through the encrypted control plane, never in URLs, manifests, logs, attachments, notifications or agent messages.
5. **Web isolation**: no file access, no native JS bridge for remote pages, no multiple windows, strict navigation policy, separate local-preview browser state. A stable port alone is not cookie isolation because cookies ignore ports, so each host-local endpoint gets a private numeric loopback address of its own, and the surface is admitted by a per-attach credential rather than by possession of a port. Landed in Slice 1b.
6. **Lifecycle**: close listeners on unmount, logout, revocation and unrecoverable disconnect; reconnect with fresh keys; retain owned Code processes only for a bounded grace; never stop user-owned dev servers.
7. **Authority**: observe-only and browser peer grants cannot launch or control surfaces. Write calls stay idempotent and current-context validated.

## Slice 0: smallest real Android feasibility path (done)

A kill test, not a product. Goal: a real `react-native-webview` surface over the existing encrypted loopback preview tunnel, driven against a host-local HTTP/WebSocket/HMR fixture and a manually started pinned `code-server`.

**Shipped in this slice**

- `apps/mobile/sources/app/(app)/surface/web.tsx`: a developer-only Web Surface route. It attaches the existing preview tunnel to one host loopback port, renders `http://127.0.0.1:<device-port>/` in a WebView, and owns loading, error, retry, back, forward, reload and deterministic detach.
- Activation: a **Developer** group on the machine detail screen, rendered only when the existing `devModeEnabled` local setting is on. The route takes no URL or port parameter, so no page, link or plugin can hand it a target; the port is typed by the device operator inside trusted muxr chrome, the same authority that already exposes host pids and ports on that screen.
- `scripts/diagnostics/application/serveSurfaceFixture.mjs`: a loopback HTTP + WebSocket fixture that pushes live updates, standing in for a dev server with HMR.
- `scripts/diagnostics/application/checkPreviewTunnel.mjs` also drives a real WebSocket upgrade and a server push through the encrypted device-side bridge.
- `apps/mobile/sources/preview/infrastructure/attachPreviewTunnel.ts`: hosted pairings mint the preview client ticket from the Device grant, the same authority the terminal and plugin-stream paths already use.

**Deliberately not in this slice**: transport hardening, endpoint leases, a surface registry, a code-server supervisor, CLI or skill entries, compatibility launchers, plugin schema changes, browser chrome, tabs, bookmarks, downloads, or any change to Kitty, `herdrGraphicsBridge.ts`, takeover, terminal semantics, wire crypto or the relay.

**Security posture of the slice**

- The WebView takes no `onMessage` handler and no injected JavaScript, so Android never attaches the `ReactNativeWebView` interface: remote pages get no native bridge.
- File access, file-URL universal access, automatic windows and multiple windows are off.
- `originWhitelist` is deliberately `*` so that every navigation reaches the app's own `onShouldStartLoadWithRequest`. The library hands whitelist-rejected URLs to `Linking.openURL`, which would be silent external navigation; failing closed in the app's own handler is stricter. Only the exact tunnel origin, plus `about:blank` for the workbench's own iframes, is allowed.
- No credential is placed in a URL, a log line or the surface chrome.

**Known limitations, stated rather than hidden**

- The device-side loopback port is fresh on every attach, so nothing persists across a reattach. Cookies ignore ports, so two host apps reached through this surface share the `127.0.0.1` cookie jar. This slice claims ephemeral proof only.
- code-server is started by hand and is not supervised, leased or credential-plumbed here.
- Only Android is claimed. iOS is untested.
- No backpressure: a large response still buffers, as the existing `ponytail:` note in `apps/host/src/requests/infrastructure/preview.ts` records.

### How to exercise Slice 0

1. On the paired machine, start the fixture: `node scripts/diagnostics/application/serveSurfaceFixture.mjs`. It prints its loopback port.
2. For the Code half, start a pinned server by hand on a disposable synthetic repo:
   `PASSWORD=<throwaway> npx code-server@4.136.2 --auth password --bind-addr 127.0.0.1:8080 /tmp/surface-scratch`.
   The password lives in the environment and the login form, never in a URL, an argument or a log line.
3. On the phone: Settings, tap the support row that toggles developer mode, then open the machine from Home, **Developer**, **Web Surface**.
4. Type the port and open. The fixture page should render, its WebSocket pill should turn green and the pushed updates should keep arriving. For Code, enter the code-server port instead.
5. Leave the screen to detach. Attaching again gives a new device port, which is why nothing is kept between attaches.

## Slice 1: transport hardening (done)

Slice 0 proved the Browser path works; it did not make it safe to point at a real repository. This slice is what has to be true before a private Browser dogfood.

**Authenticated framing.** The preview wire gains a version. v1 is the legacy takeover layout, byte for byte as it shipped. v2 puts a version byte, the connection id, the flag and a strictly monotonic per-direction sequence in the header, and repeats all four inside the sealed body, close frames included. One shared codec in `@muxr/crypto` implements the rules for both ends, so the device and the host cannot disagree about them. A frame that was tampered with, replayed, reordered, remapped onto another connection or reflected back down its own direction fails to open, and it fails **before** the receiving end opens or writes an upstream socket. A rejection ends the tunnel; nothing resynchronises. A tunnel negotiates its version once at attach time and never sniffs, so the two layouts are never ambiguous.

**Endpoint leases.** `preview.attach` no longer takes a caller-chosen port on the product path. The device asks for a lease, and the host records machine, device, surface kind, access, provider, context, endpoint, the plugin catalog digest it was issued under and an expiry; attach quotes the lease and the host resolves the endpoint from its own table. Access is explicit: `developer` is an operator typing a loopback port inside muxr's own chrome and can reach anything listening on that machine, so it stays a named diagnostic operation; `product` binds the lease to the capability provider and the worktree it belongs to, with the provider validated against the catalog as an opaque id the kernel never names.

Standing is re-read rather than remembered. A lease needs an **explicitly live, unexpired, control-authority device grant** every time it is touched -- a grant that was removed leaves no authority entry behind, and an absent entry is not permission. An authority read that fails, and a plugin catalog this host cannot read, both count as "no": neither is treated as an empty table. Expiry, revocation, a changed snapshot, a provider that is no longer enabled and a failed catalog read each close the live listener and every connection under it, within about a second, and authority is re-read before each new upstream dial as well.

Ownership is taken **before** the awaits, not after them. Attach claims the lease, then looks the catalog up and connects the transport, then revalidates the claim; a lease released, expired or superseded by a retry while that ran loses, and the transport it opened is closed rather than left running unowned. A tunnel that dies on its own gives its lease back.

Renewal is device liveness, not holder existence. While its surface stays
mounted, foreground, and approved, the device sends authenticated
`preview.renew` every 4 minutes -- under half the 10-minute TTL -- over the
encrypted control plane, and requires acknowledgement: a rejection or a
deadline tears down the complete mobile owner. The host re-reads exact
receiving-device approval, exact offer generation, and exact live session on
every renew (even far from expiry), re-resolves after every await, and
renews the bound offer alongside the lease as state only. The holder timer
itself never touches: sixty simulated minutes with a live tunnel object and
no device exchange ends the lease and closes the tunnel. A lease with no
live tunnel still runs out on its own. Leases are bounded per device and in
total, and the device gives one back when the surface closes. Every gateway
request and every WebSocket upgrade re-reads the same live standing before
any upstream dial, so approval, offer, or session loss refuses new work
even before the second-cadence sweep closes the gateway.

**Flow control.** v2 runs on authenticated per-connection credits, in both directions. Each end may have `PREVIEW_WINDOW_BYTES` of payload outstanding per connection and stops reading its own socket when that runs out; it hands the peer window back only from its own write's **completion callback**, never on the frame's arrival, so the sender can never outrun the far end's drain. Crediting on arrival is the same as having no window at all -- the peer refills instantly and queues without bound in the receiving process -- which is why both ends count writes in flight rather than writes accepted. Credit frames go through the same codec as everything else, so a forged, replayed or re-flagged credit is refused, and they are clamped so one cannot push a peer past the ceiling. Credit and close frames cost no window, so control stays deliverable under pressure. Frames are bounded -- one chunk each way, refused before a secretbox open if larger -- and so is the inbound side: a peer that sends past the window it was granted ends the tunnel rather than queueing bytes nobody bounded.

Pausing the device's own WebView socket, which is what the bridge used to do when its response queue grew, throttles the wrong producer entirely: it cannot slow a host that is sending. Connection counts stay bounded on both ends and the old queue ceilings remain as backstops. Nothing drops arbitrary TCP bytes -- a closing connection drains what it was credited before it says goodbye, and past a ceiling the tunnel or that one connection closes and says so. The relay's own v1 listener path is unchanged, and legacy takeover keeps v1 framing with no credits at all.

**Closing without truncating.** A close frame never destroys a socket that still owes it bytes. The device drains what it was credited before it ends a request, and the host drains the request body it accepted before it ends the upstream, so a browser that closes mid-upload still delivers a whole body to the dev server. Unsent backlog is bounded explicitly on the device -- per connection and in total -- because `pause()` there crosses the native bridge and reads can still land after it; on the host node guarantees no further `data` after `pause()`, so its backlog cannot exceed one read.

**Lifecycle and authority.** One idempotent owner on the device holds everything an attach opens. Relay close, relay error, host death, a bridge that fails its checks, a startup timeout, leaving the screen and the caller's own close all reach it, and the listener, the socket and the caller's notification each happen exactly once. The lifetime handlers are installed **before** startup rather than by the startup step, because the previous arrangement replaced them with the bridge's own `onmessage` and never reinstated them: a relay or host that died after startup tore nothing down, so the device kept its loopback listener open and the page went on believing it had a socket.

Leaving mid-attach cancels through the same owner, and a bridge that finishes starting afterwards is closed rather than returned to nobody -- it owns a live device port either way. A reattach mints a fresh key and a fresh sequence, so nothing from a previous connection is accepted. Observe-only and peer grants could not reach `preview.*` before and cannot hold a surface now; the lease is bound to the device it was issued to.

## Slice 1b: local admission and private origins (this slice)

Slice 1 made the wire safe. It did not make the *device end* safe, and that is
the half a phone actually exposes: Android says plainly that a loopback listener
is reachable by other apps on the same device, and cookies ignore ports, so a
tunnel that ends at `127.0.0.1:<ephemeral>` is a dev server behind no gate at all
and one cookie jar shared by every endpoint reached that way. Encryption between
phone and host addresses neither.

**A gateway, not a dial.** `attachPreview` no longer dials the dev server. It
dials a lease-owned HTTP/WebSocket gateway on this machine's own loopback, and
that gateway is the only thing that dials the registered endpoint. It is written
on node's own parser, because a hand-rolled header splitter in a security proxy
is a request-smuggling bug waiting to happen: llhttp already refuses duplicate or
conflicting `Content-Length`, `Content-Length` beside `Transfer-Encoding`,
invalid chunking, obsolete folding and bare-LF delimiters, and it refuses them
before a request object exists. The device bridge stays a byte bridge; there is
no HTTP parser in React Native, and there will not be one.

**A credential, not a port.** Compiled mobile mints an independent 256-bit
admission credential per attach -- independent of the frame key, because a value
that unseals frames must never also be the value that opens the gateway -- and
sends it only inside the encrypted `preview.attach` request. It is installed
before navigation as a host-only, `HttpOnly`, `SameSite=Strict`, `Path=/` cookie
in the WebView's own cookie store: the structured setter with no `domain`
input, so native defaults it to the exact request host (effectively host-only
for an IP literal, where RFC 6265bis allows no suffix domain-matching), and
with the WebKit store selected on iOS, where `setFromResponse` hard-codes
Foundation's store and the WKWebView would never send what it installed. The
write is read back from the same store before the surface navigates, because a
store that refused it looks exactly like one that took it. No injected
JavaScript, no `onMessage`, no `ReactNativeWebView` interface, and the credential
never enters URL text, page JS, app chrome, diagnostics, logs or agent output.

**What the gateway checks, on every request and every upgrade.** Exactly one
reserved cookie, byte-equal name, constant-time value -- zero, two, a case
variant, a `__Host-`/`__Secure-` prefix or a wrong value is a refusal, not a
search. Exactly one `Host`, equal to this surface's authority (node accepts a
duplicate `Host` and keeps the first, so the count is checked on the raw
headers). `Origin`, when present, equal to the surface origin exactly; an upgrade
without one is refused. Origin-form targets only, so an absolute-form request
line whose authority disagrees with `Host` gets nowhere. Header count and byte
ceilings, a five-second header deadline, and a bounded number of sockets that
have not yet produced an authenticated request. `Expect: 100-continue` is relayed
rather than answered, so an unadmitted caller is never told to go ahead. `CONNECT`
is destroyed. An upgrade is `websocket` or nothing, carries no pipelined bytes,
and becomes an opaque duplex stream only after an upstream `101` whose
`Sec-WebSocket-Accept` actually answers this client's key.

**What it rewrites, what it emits, and what it refuses to.** Only muxr's reserved cookie is
stripped; application cookies and `Authorization` are forwarded untouched. `Host`
and an exactly-matching `Origin` are rewritten to the registered upstream, because
that is what makes an unmodified dev server's own CSRF and WebSocket checks pass
-- erasing them is what would make it unsafe. A `Location` naming the upstream's
own authority is translated back to the frontend's; one naming any *other*
loopback authority fails closed, because a dev server does not get to hand the
phone a port nobody leased it. A CORS origin matching the upstream exactly is
translated to the frontend origin and never to a wildcard. An upstream
`Set-Cookie` for the reserved name is dropped, so nothing upstream can replace or
clear the surface's admission; a `Domain` naming the upstream host is dropped so
the cookie survives as host-only, and `Path`, `Secure`, `HttpOnly` and `SameSite`
are the application's and stay exactly as they were. Every admitted page
response also carries the gateway's own content policy: `connect-src`,
`worker-src`, `frame-src` and `form-action` pinned to the exact origin
(`'self'` covers scheme, host *and* port), with `https:`/`wss:` scheme
sources for external resources and no plain-`http:`/`ws:` source anywhere --
so script inside the surface cannot make a credentialed request to another
port on its numeric host, while same-origin HMR/SSE and external HTTPS keep
working and plain-HTTP cross-origin dependencies fail closed instead of
loading silently. (Final repair tightened `worker-src` from `'self'` to
`'none'`: no worker may be acquired inside the surface at all. See below.) Upstream enforcing policies are kept alongside it (enforced
policies intersect, so upstream cannot widen it); report-only policies and
reporting headers/endpoints are dropped, since their endpoints are an
off-origin channel of their own. Top-level navigation stays exact-origin in
the app's own handler. There is no HTML or
JavaScript rewriting. The promise is unchanged, proxy-compatible dev servers --
not transparency for an application that hardcodes its own absolute URLs.

**A stable, isolated origin, allocated by the host.** `preview.lease` now returns an opaque fingerprint
of the endpoint itself -- a digest over machine, surface kind, access and either
the port or the provider and context -- plus the host-allocated private origin
assignment for it (final repair includes the service port in the product
identity as well, so ports 3000 and 4000 of one provider differ; pre-fix
shared assignments retire by table version and are never served again): a numeric `127.a.b.c` host with octets one and
four inside 1..254, plus a stable port in 40000..59999. Numeric, because
`*.localhost` resolution is not a portable assumption across WebView releases.
Per-endpoint hostname, because cookies ignore ports and two endpoints on one hostname would
share a jar; localStorage, IndexedDB and service workers key on the full origin
and separate too. Allocated and persisted by the host under its data directory
(atomic 0600 writes, append-only, never reassigned while old state may survive),
because pure derivation truncates the fingerprint with no memory and a bind
conflict only fires when both endpoints are live at once. The v2 first
assignment hashes through a v2 domain -- never the legacy derivation -- so a
loaded v1 address cannot reappear, and every v1 hostname ever seen is a
tombstone the allocator never serves again; a colliding endpoint is moved to
a free hostname instead of sharing. Corrupted or unwritable state fails every
surface closed. The device learns the assignment inside the encrypted lease
result and binds it; the host pins the gateway's `Host`/`Origin` checks to
the lease's stored assignment, so a caller cannot choose the origin its
surface answers to and no device-supplied Host or origin is trusted. The
lease result also carries the host assignment epoch: the phone pins under
it, and a changed epoch -- legitimate host state loss -- retires that
machine's prior pins before any fresh origin is accepted, instead of
refusing every known endpoint with an impossible instruction. Phone-side
pins never evict while browser state may survive; the reverse map is global
over the canonical hostname (no per-machine, no per-port owner, because
cookies ignore ports); persistence is serialized and fail-closed, and a
read/write/parse failure blocks the attach and quarantines the origin
rather than being swallowed.

**Ownership before credentials, and after them.** The device binds that exact
address before the credential is installed and before anything navigates; a bind
that does not take ends the attach with no fallback and no second address.
A pre-aborted attach releases its reservation before throwing, and every
throw after reservation releases safely, so no failure wedges the slot.
Cleanup responsibility is recorded before the native install can partially
succeed. Detach unmounts the renderer first, then awaits verified
reserved-cookie removal while the slot and listener stay owned, then closes
bridge, address, and lease and releases the slot; native cookie operations
are bounded. If verification is unreadable or deletion fails, the slot stays
owned, the origin is quarantined, and the failure reports -- nothing is
freed for a new attach. Stale cleanup carries its generation and can
neither erase nor release a newer attach. One surface is open app-wide,
because Android's WebView cookie store belongs to the process rather than to a
WebView and `react-native-webview` exposes no per-profile store; pretending port
identity covers the rest is exactly the assumption this slice exists to remove.
Authority still comes from the live lease, never from cookie lifetime: expiry,
revocation, a changed snapshot and a dead tunnel close the gateway and its
upgraded sockets along with the tunnel. Credential cleanup failures reach
the pane as user-safe copy with detailed diagnostics kept local.

**Contract.** `preview.lease` gains `endpoint`; `preview.attach` gains
`admission`. Both are validated on both sides -- shape-only for the credential,
since nothing may branch on a secret -- and a credential offered to the legacy
port path is refused, because there is no gateway there to admit it to. Legacy
takeover keeps v1 framing, port attachment and `127.0.0.1` binding untouched.

**Residual risk, stated rather than hidden.**

- **Same-site is per host, not per port.** `http://127.a.b.c:PORT` and
  `http://127.a.b.c:9999` are the same site, so without a content policy script
  running inside the surface could make a credentialed request to another port
  of that address and hand the credential to a local listener. `HttpOnly` does
  not help: the page never reads the cookie, the browser attaches it. The
  gateway's response policy now closes the practical channels -- subresources,
  fetch, EventSource, workers, WebSockets, frames and forms to any plain-HTTP
  or plain-WebSocket off-origin target fail closed -- and top-level navigation
  stays exact-origin in the app handler. What it cannot express is "this host,
  other port, over TLS": `https:`/`wss:` sources necessarily also match this
  host over TLS, and no listener there can present a trusted certificate for a
  numeric 127/8 address, so in practice nothing answers to capture the
  credential. Peer-UID checks would close even that, and are not available:
  `SO_PEERCRED` is AF_UNIX-only and `getConnectionOwnerUid` is restricted.
  The credential stays per-attach and is cleared on detach, which bounds the
  window to one surface lifetime.
- **A stable origin is a poisonable origin.** Service workers, IndexedDB,
  localStorage and application cookies survive detach and reattach by design.
  A worker registered at `/` intercepts the first navigation of the next attach
  before a byte reaches the gateway. (Final repair closes the worker half:
  `worker-src 'none'` blocks acquisition inside the surface, and the origin
  table version retires pre-fix assignments that could already hold a
  registration. The storage half -- IndexedDB, localStorage, app cookies --
  persists by design; the real control remains a per-endpoint WebView profile
  (`androidx.webkit` `MULTI_PROFILE`), which `react-native-webview` does not
  expose, so one surface app-wide is still the bound.) An independent
  review argued for a fresh random origin per attach instead, which would close
  this and the point above at the cost of the persistence the approved
  architecture asks for; the approved stable-origin decision stands and this is
  the price of it.
- **The assignment is guessable, and pre-bindable.** Machine id, kind, access and a
  conventional dev-server port are all guessable. The v2 first assignment no
  longer keeps the legacy derived hostname: it hashes through a v2 domain, so
  a loaded v1 address cannot reappear, and every v1 hostname ever seen is a
  tombstone the allocator never serves again. An app that knows the machine
  id can still pre-bind a fresh address and turn one surface into a
  fail-closed denial of that address -- allocation persistence means the
  squat can never become credential sharing -- and an HMAC under a
  host-held secret would fix even the squat.
- **`incognito` on any other WebView in the app clears the process-wide cookie
  jar.** The attachment preview sets it. The surface fails closed rather than
  running unadmitted, but it does fail.
- **iOS cannot bind this yet.** Darwin binds only `127.0.0.1`; any other loopback
  address returns `EADDRNOTAVAIL`. The surface therefore fails closed on iOS
  today, with no `127.0.0.1`, wildcard, shared-store, DNS or random-port
  fallback -- a bind that does not take ends the attach. The admission path no
  longer assumes Foundation either: install, read-back and clear all address
  the WebKit store the WKWebView reads. Still unproven on hardware; nothing
  about iOS is claimed until an owned Mac and iPhone run it.
- **Lease renewal is device liveness now.** The holder timer never touches:
  only authenticated `preview.renew` exchanges advance presence, so a
  blackholed device with a live relay socket runs out on its TTL.
- **Unauthenticated callers still cost tunnel slots.** The gateway bounds
  concurrent unadmitted sockets and refuses fast, but the device bridge cannot
  tell an admitted connection from a hostile one, so a local app can churn
  connection ids. That is denial of service, not admission.

## Slice 2: Browser product

Build `muxr.browser`, Web Surface chrome, direct HTTPS mode, local-tunnel mode and explicit host-session mode. Add the Surface CLI and skill entry.

**Gate:** the Browser Tools button opens the new Surface; HTTPS, local HMR/WebSocket, keyboard, scroll, selection, background/resume, reconnect and close work; zero Browser PTY or Kitty launch.

## Slice 2A: Surface offer contract, broker and CLI (this slice)

No mobile presentation or UI. What landed:

- Versioned, typed, bounded `surface.offer` contract for exactly three
  targets: Browser direct HTTPS (plus the honest `about:blank` blank tab),
  Browser host-local (host-owned port plus relative path, label and
  context) and Code review/navigation (`mode: review`, no editing).
  Semantic capabilities (`surface.browser.open`,
  `surface.browser.control-host-session`, `surface.code.open`), placement
  intent only, monotonic revision per logical name and session, bounded
  name/title, expiry, and an opaque offer handle.
- The local broker writes offers bound to the exact live agent session
  (`HERDR_PANE_ID` must resolve to a pane with a publishable session;
  cwd-only hints must identify exactly one live session; stale, moved,
  shell and ambiguous contexts fail). Every open/update/reload/close emits
  a bounded typed `surface.offer` HostFrame carrying the handle, session,
  revision, expiry, operation and the host-resolved provider inside the
  existing encrypted control plane, directed only at currently
  control-authorized devices -- never peers, view-only, revoked or expired
  grants; local/dev hosts broadcast on the existing path. Host reconnect
  replays current offers, and a phone rejoining an already-connected host
  replays only to itself from `client.hello`. Handles and session ids stay
  out of CLI and agent output. Reload and target-less update are accepted
  and re-emitted, never claimed visible before a device acknowledgement
  exists. Every materialized offer carries its host-resolved claimant, so
  the mobile admits a surface only while that exact provider stays approved
  and still claims the capability; `--provider` is never a no-op.
- There is deliberately no client-to-host surface path: the required
  activation is agent/local broker into a host-originated frame, and mobile
  needs only product `preview.lease` and `preview.release` in this slice.
- Host-memory offer registry. Open/update/close are idempotent and
  session-bound. Product `preview.lease` consumes a current local Browser
  offer handle, resolves port/provider/context from host-owned state, and
  additionally requires the receiving device's live approval of the
  provider for that capability; a phone-submitted product
  port/provider/context is refused, and so are expired, closed, replaced,
  unapproved, direct-HTTPS and Code offers. Approval state is part of the
  live lease snapshot, so revocation closes held tunnels. The developer
  typed-port lease is unchanged.
- Generic provider resolution (explicit valid claimant, then saved valid
  claimant where a convention exists, then the sole enabled/approved
  claimant; missing/ambiguous fails visibly) over manifest-declared
  claimants. Nothing names a third-party plugin id. `surface capabilities`
  reports honest per-capability availability and ambiguity from installed
  claimants and never claims an unavailable provider; direct and Code
  offers require a host-installed claimant. The packaged `muxr.browser`
  claimant and `surface.code.open` on the existing native `muxr.code`
  package (`files.read`) are the two in-tree claimants; no code-server, no
  editing authority.
- Host-local authenticated Unix broker under the host data directory
  (owner-only socket, bounded requests, deadlines, stale-socket handling,
  deterministic close). No relay/token/capability secret in env or output.
- CLI: `surface capabilities|list`, `browser open|home|update|reload|close`,
  `code open|diff`, plus the `surfaces` skill topic. Replies say accepted,
  visible or failed, stay human-readable by default and JSON on request, and
  never print offer/session/pane/lease/device ids. `--` separators work;
  credentials in URLs, non-HTTPS remote URLs, unsupported schemes,
  oversized fields, worktree escapes and ambiguous authorities fail closed.
- No compatibility sources: legacy launcher packages are neither migrated
  nor impersonated (removed 2026-09-11; there are no live users). No-target
  invocations open the blank tab / worktree root. No pane/PTY/Kitty/CDP/
  code-server process anywhere.
- `surface-origins.json` assignments are bounded (256); allocation past the
  ceiling refuses instead of recycling a hostname.

Explicitly not in this slice: mobile Web Surface chrome, tabs, downloads,
foreground/follow preferences, iOS proof, and any change to Kitty, takeover, terminal semantics or existing
requests (all preserved).

## Slice 3: withdrawn

This was the Code product. It is not being built. See **Code (killed at Slice 0)**.

## Slice 4: full QA and release proof

Focused contract, crypto, host, mobile and plugin flows, then a sequential full `yarn run check`. Signed Android release build on a dedicated emulator, never the retained `emulator-5554`. Real user-visible Browser flows with screenshots, logs, process proof and artifact hashes. Throttled transport, concurrent surfaces, reconnect, revocation and cleanup. Physical-phone keyboard, selection, scrolling, pinch and settled rendering. iOS is not claimed until owned Mac and iPhone verification runs.

## Acceptance

- The same visible Browser entry point opens a first-class non-terminal surface.
- Browser never starts a PTY or consumes Kitty graphics.
- Real DOM input, selection, accessibility and scrolling work.
- Local WebSockets and HMR work.
- Queues, connections and memory stay bounded.
- Reconnect, revoke and close are deterministic and leak-free.
- Security tests reject endpoint substitution, frame replay/remapping and stale authority.
- Existing terminal, Files, Changes, History and takeover flows stay green.

## Rollback

Disable the Browser Surface capability, revoke active leases, and preserve repositories and profiles. Rollback does not re-enable Kitty automatically. Rolling back Slice 1 alone means attaching by port on the legacy layout again, which is why the device refuses to run a surface unless the host confirms the authenticated one.

## Rejected

- Monaco or a custom React Native IDE.
- New WebRTC or remote-desktop infrastructure.
- Generalized CDP or JPEG browsing.
- A relay-decrypted HTTP proxy.
- Downloaded plugin HTML or native callbacks inside trusted muxr chrome.
- `.url` attachment files as the primary activation bus.
- Further Kitty optimization for Browser or Code.

## Verification

### Slice 0 (done, 2026-09-10)

Verified on a dedicated `medium_phone` x86_64 emulator against a hosted pairing.

- [x] The Web Surface loads the host fixture over the encrypted tunnel; its same-origin WebSocket opens, keeps receiving pushes and echoes typed text.
- [x] Back, forward, reload, retry, reattach and close behave; closing leaves zero device listeners across repeated cycles.
- [x] A foreign-origin link is refused and the app stays put.
- [x] Zero PTY and zero Kitty frames in the path.
- [x] code-server loaded, saved host bytes exactly, searched, undid and pasted, and survived background and offline. **Its product criterion still failed:** finger selection cannot cross lines and the IME was unreliable, so Code is killed.

### Slice 1 (done)

Green here:

- [x] `packages/crypto/dist/selfCheck.js` covers the codec: tamper, replay, reorder, remap, re-flag, rewritten sequence, wrong direction, authenticated close **and credit** frames, bounded frame size in both directions, a fresh sequence per reattach, and v1 unchanged.
- [x] `apps/host/src/requests/infrastructure/previewTransport.test.ts` holds a downstream write open and proves the host says nothing until it completes, then credits exactly those bytes; a close frame arriving over an unflushed body does not destroy the socket, and once the body lands the connection ends once with the whole body delivered. Both halves were confirmed by reintroducing the bug: crediting on arrival fails the first assertion, destroying on the close frame fails the second.
- [x] The same file drives the real forwarder. Six megabytes cross a leased v2 tunnel byte for byte **on credit**: with none issued the host puts at most one window on the wire and the dev server feels the stop, and the rest moves only as the device credits it; the host credits an upload back only once its own write completed. Tampered, replayed, **same-root reflected**, forged-close, oversized and **new-root reattach replay** frames are all refused before any upstream dial, and failing closed takes the upstream connection with it. Leases bind device, machine and expiry; revocation, an authority read that throws, a changed snapshot and an unreadable catalog each close a live tunnel; a held lease renews while an abandoned one expires; a release or a second attach during an in-flight attach closes the loser's transport. The legacy layout still works.
- [x] `apps/host/src/requests/application/createRequestDispatcher.test.ts` proves a view-only grant gets no lease, **a device with no grant recorded gets no lease**, another device cannot attach to one, and a catalog read that fails issues nothing.
- [x] `apps/mobile/sources/preview/infrastructure/previewBridge.spec.ts` proves the device end credits only on completed writes, stops sending when its own window runs out and resumes on credit, and fails closed both on a frame that does not check out and on a host that sends past the window it was granted.
- [x] `apps/mobile/sources/preview/infrastructure/attachPreviewTunnel.hosted.spec.ts` proves a remote close tears the tunnel down exactly once, and that leaving the screen mid-attach closes the bridge that arrives afterwards.
- [x] `node scripts/diagnostics/application/checkPreviewTunnel.mjs` still passes, so legacy takeover on v1 is untouched.
- [x] Workspace and mobile typecheck, both package architecture guards, and every vitest flow.

### Slice 1b (done)

Green here:

- [x] `apps/host/src/requests/infrastructure/surfaceGateway.test.ts` drives the real gateway over real loopback sockets against a real dev server with a real WebSocket endpoint, and counts what reached it rather than what the gateway answered. With no credential, the wrong one, two of them, two `Cookie` headers, a case variant, a `__Host-` prefix, a nameless pair, a wrong `Host`, a duplicate `Host`, a foreign `Origin`, an absolute-form target, a POST, and a fully forged WebSocket handshake, the dev server sees **zero requests and zero connections**. With the right one, HTTP streams, an upload streams, and a same-origin WebSocket opens and carries a server push -- and the dev server is handed the application's cookie, its own authority, and never the reserved cookie. An upstream `Set-Cookie` for the reserved name is dropped, its CORS origin is translated to the exact frontend origin rather than a wildcard, a redirect to its own authority is translated back, and one to another loopback port fails closed. Every admitted page carries the gateway's exact-origin content policy with no plain-HTTP/plain-WS source; a permissive upstream policy survives alongside it without widening it, while its report directive, report-only policy and reporting headers are all dropped. Closing the gateway takes the upgraded socket with it. Both halves were confirmed by reintroducing the bug: relaxing the duplicate-cookie rule and dropping the `Host` check both put `dev-server-body` through.
- [x] `surfaceOrigins.test.ts` proves one hostname per endpoint across reattach and restart from disk (0600), a colliding endpoint moved to a free hostname instead of sharing, and corrupted state failing every surface closed.
- [x] `previewTransport.test.ts` proves the endpoint fingerprint is the same for two leases on one endpoint and different for another, that the two hold different host-allocated hostnames with well-formed authorities, and that neither is `127.0.0.1`. It also proves the use case refuses a leased attach with no credential and with a malformed one, refuses a credential offered to legacy takeover, pins the frontend authority from the lease's stored origin assignment, and refuses a lease that names none.
- [x] `createRequestDispatcher.test.ts` proves a lease alone opens nothing: a surface without an admission credential is refused before the device check.
- [x] `attachPreviewTunnel.hosted.spec.ts` proves the device binds the host-assigned 127/8 address rather than `127.0.0.1:0`, installs the credential only after that bind and only on that origin, sends it only inside `preview.attach`, and keeps it out of the relay URL and out of everything the caller is handed. A leased attach with no host assignment never binds. A second endpoint would land elsewhere and is refused while one surface is open; closing clears the credential **before** it releases the address; the same endpoint reattaches to the same address; and a bind that will not take fails the attach with no fallback origin. Confirmed non-vacuous by dropping the bind address.
- [x] `surfaceAdmission.spec.ts` proves install and clear address the WebKit store on iOS with a host-only, `HttpOnly`, `SameSite=Strict` cookie, read it back from the same store, and fail the attach when the store refuses it.
- [x] `node scripts/diagnostics/application/checkPreviewTunnel.mjs` still passes, so legacy takeover on v1 with port attachment and `127.0.0.1` binding is untouched.
- [x] `yarn build`, crypto and contract self-checks, both architecture guards, the core-purity and secret scans, and the full vitest sweep (51 files, 225 tests).

Still to prove on hardware, and the reason this is not a dogfood gate yet:

- [ ] A paired Android build: the surface binds its 127/8 address, the cookie lands in the WebView's own store with `HttpOnly` and `SameSite=Strict` and is read back, and the page loads, streams and holds a WebSocket through the gateway.
- [ ] A second Android app on the same device, attempting GET, POST and a WebSocket upgrade against that address with forged `Host` and `Origin`: zero requests reach the dev server.
- [ ] A service worker registered at `/` by one attach, and what it does to the next one on the same origin. (Superseded: `worker-src 'none'` blocks acquisition and pre-fix origins retired; remaining proof is the emitted header, covered in flow tests, plus device confirmation.)
- [ ] Occupied-address behaviour: another process holding the address before an attach, and after an abnormal loss of it.
- [ ] `am force-stop` leaving no reserved cookie behind, and no reserved cookie surviving an app restart.
- [ ] iOS: the 127/8 bind is expected to fail with `EADDRNOTAVAIL` and the surface to fail closed. Unproven on hardware; nothing about iOS is claimed until an owned Mac and iPhone run it.
- [ ] `node scripts/diagnostics/application/checkPreviewTunnel.mjs` through a live relay and host.
- [ ] A paired Android build: the surface opens through a lease, survives its own expiry honestly, and closes deterministically on revoke and disconnect.
- [ ] A throttled real relay carrying a large response without unbounded memory on any of the three hops.

### Slice 2A (this slice)

Green here:

- [x] `packages/contract/dist/selfCheck.js` covers the offer contract: direct HTTPS and `about:blank` validate with a host-resolved provider; provider-less inputs, plain-HTTP, credentialed and `file:` URLs and worktree escapes are rejected; sole claimant resolves and ambiguous providers fail visibly; the `surface.offer` HostFrame round-trips through the payload codec and rejects wrong operations, lease-id handles and provider-less offers.
- [x] `apps/host/src/requests/infrastructure/surfaceSlice2a.test.ts` drives the real registry, the real dispatcher and the real broker: a session-bound local Browser offer leases by handle with the host-owned port/provider/context; forged product params, replaced and closed offers, unapproved providers, revoked approvals (new leases refused, held attach reports the changed snapshot), direct-HTTPS and Code offers all produce no lease; removed client surface types answer host-contract-mismatch instead of injecting offers; the developer typed-port lease is unchanged;   registry events fan out as guard-valid frames carrying the stored provider for live control devices only (peers, view-only, revoked and expired excluded), and phone-reconnect replay reaches only the rejoining control device; stale-pane, shell, and ambiguous broker contexts, unknown and ambiguous providers, plus pane-plus-foreign-cwd hints (outside the session root, sibling prefixes, symlink escapes, and unresolvable paths fail; exact and real-subdirectory hints keep the pane's context), uninstalled-claimant direct opens, credentialed and plain-HTTP-remote URLs, and worktree escapes all fail; explicit providers resolve and persist on direct offers; reload re-emits as accepted with the same revision; broker replies carry no ids or secrets.
- [x] `scripts/surface/cli.test.mjs` proves CLI usage and broker-unreachable failures print no ids or secrets, `--` separators and `browser home` reach the host instead of misreading, the display redactor strips handle-like fields, and a real standalone CLI process reaches a live broker with no pane, PTY, Kitty, CDP or code-server process.
- [x] `yarn build`, crypto and contract self-checks, host and relay architecture guards, the package architecture guard, the core-purity and secret scans, the bundled-plugin check, and the neighboring suites (`createRequestDispatcher`, `previewTransport`, `surfaceGateway`, `surfaceOrigins`, `pluginCatalog`) stay green. No Android build; no mobile UI in this slice.

Still not claimed: mobile Web Surface chrome, iOS proof, and the Slice 1b hardware list above, which is unchanged.

## Slice 2B: Browser/Code product integration (this slice)

No new transport. What landed is the mobile half of Slice 2A's contract, plus
two contract/host corrections the integration forced:

- **Directed offers.** `MuxrClient` gains a typed `onSurfaceOffer` listener
  that accepts only `isSurfaceOfferHostFrame` after successful host E2EE
  decoding. Host frames addressed to `*` still open; frames directed at the
  exact current grant recipient now open too, through
  `DeviceV2Crypto.openFor`, which binds the sealed recipient (`*` or exactly
  this device id) into the authenticated context and fails everything else
  closed. Directed frames seal under a recipient-confidential key derived
  from that device's own ingress root: a holder of the shared broadcast
  root cannot decrypt them. Sealing proves current, unexpired control
  standing at every transmit and queue flush; expired, observe, and revoked
  recipients get nothing sealed. Replay tracks the authenticated recipient
  as well as the stream: the host seals broadcast and directed frames from
  independent sender states whose sequences overlap, so a shared tracker
  would reject a directed seq 1 forever after a broadcast seq 1.
  Pre-recipient broadcast snapshots are adopted once under the `*` key and
  the legacy entry is dropped, never written back. Peers keep their
  isolated egress path. Every other header check (sender, channel, stream,
  key version, machine) is unchanged.
- **Mobile coordinator.** Sync registers the listener and feeds one bounded
  store (`catalog/application/surfaceCoordinator.ts`) keyed by exact
  machine + session + handle: monotonic revisions only, replay idempotent,
  close removes, expiry fails closed, user Close dismisses one exact handle
  while a newer revision may still appear, 16 retained entries. Selection
  keys on the logical surface name, never the handle, because an update
  replaces the handle; `findSurfaceEntry` resolves the current record, so a
  newer revision feeds the mounted surface instead of dropping it. Handles
  and session ids never reach the UI.
- **Admission before visibility.** An offer becomes usable only while its
  exact `offer.provider` is in the approved compatible snapshot and claims
  the offer's exact semantic capability. The catalog still loading queues
  briefly; otherwise a quiet unavailable reason shows and nothing attaches.
  Revocation tears the offer down, and observe devices fail closed locally
  even though the host already sends them nothing.
- **Real Browser companion.** `requestProductSurfaceLease(offerHandle)`
  sends only `{kind:'browser',access:'product',offer}` and validates the
  assignment exactly like the developer path. The local offer attaches with
  the frame handle and loads the offered relative path on the assigned
  stable origin after cookie install. `https:` and `about:blank` use the
  phone-owned WebView directly and never open a lease. One shared hardened
  `SurfaceWebView` (no `onMessage`, no injected script, no file access, no
  new windows, no mixed HTTP) serves the developer screen and the product;
  local mode allows the exact assigned origin plus `about:blank`, direct
  mode allows HTTPS plus `about:blank` and rejects credentials and other
  schemes. Chrome is compact and trusted: essential Back/Reload-Stop, an
  editable credential-free HTTPS address for direct and blank tabs, a human
  offer label for local pages (never the numeric loopback host, ids,
  credentials or raw context), Return to agent, and one overflow menu
  holding Share, Open in system browser and Close. A blocked foreign HTTPS
  link becomes an explicit choice -- open in the phone Browser, the system
  browser, or stay -- and any other blocked navigation says it cannot open
   here; nothing vanishes silently. Scheme-less address input is treated as
   HTTPS. Touch on the page itself (the WebView wrapper only -- chrome taps
   on Reload, Return to agent, and overflow never end follow mode), scroll,
   navigation and address submit count as user
   interaction through native signals only; no page script is added.
   (Form-element focus cannot be observed without a bridge, so it is not
   claimed as a signal.)
   Lifecycle ordering is bind, cookie install with read-back, mount, then on
   teardown unmount, credential clear (awaited and verified absent while the
   slot and listener stay owned), bridge/address close, slot release, lease
   release; an unverified removal keeps the slot, quarantines the origin,
   and reports instead of freeing. Background only (never mere inactivity),
   provider loss, renderer death,
   host death, unmount and explicit close all reach it. Foreground reattaches
   to the last observed same-origin path -- form memory is explicitly
   sacrificed to the teardown rule -- while the WebView stays unmounted until
   the new bind and cookie verification complete; provider/authority loss
   shows its reason with no Reopen action until approval and control return.
   Security caveat, documented not fixed: on Android the autofill credential
   picker counts as background, so a login completed through the picker parks
   the surface and resumes to the last path with the form empty; on iOS
   Control Center, the shade, and calls are `inactive` and leave the surface
   alone.
   A lost tunnel clears the page rather than showing it dead. Authenticated
   `preview.renew` proves holder liveness every 4 minutes while a
   surface stays mounted, foreground, and approved, and requires
   acknowledgement: a rejection or a deadline tears down the complete mobile
   owner, and the loop stops on detach, background, and unmount. Renewal
   extends expiry and re-emits the offer as state only; explicit reload
   carries a fresh monotonic command, executes once after machine/session/
   revision checks, and respects the interaction policy (a reload arriving
   after interaction waits behind Show).
- **Adaptive workspace.** The session route wraps the existing
  `TerminalScreen` without rewriting it; terminal and surface stay mounted
  across focus changes so viewport, draft, URL, history, scroll and tunnel
  survive. When no Surface exists the Agent takes 100% width on every
  layout. Compact (below 764dp wide) keeps the Agent default with
  a quiet 64dp dock, shown only while offers exist or a surface is mounted --
  zero offers and no surface means no strip at all, and the blank Browser
  lives in the session pane-actions overflow instead. Browser/Code ready
  taps focus the surface, Back walks
  WebView history first then returns to the Agent without closing, and
  offers never steal focus. Wide (at/above 764dp,
  i.e. exactly 360 +
  divider + 360 so each pane stays >=360dp -- no height gate, so a
  914x411dp phone landscape splits) shows the selected Browser beside the
  Agent at 50/50 below
  840dp and 40/60 at/above, with a 44dp Gesture-Handler/Reanimated divider
  clamped to the minima and a persisted per-device ratio; shrinking drops to
  the single focused pane without remounting. Every measured container width
  change recomputes divider-aware clamps and shared geometry. Wide with a
  mounted surface still exposes every other Browser/Code offer while hiding
  the selected duplicate; the keyboard always hides the dock. One stable tree: terminal and
  surface containers keep constant keys and positions while only visibility
  and geometry flip; a hidden compact pane keeps full-bounds nonzero layout
  (absolute, transparent), is non-interactive and a11y-hidden, never
  `display:none`. A newer revision follows the mounted local and direct
  surfaces before the user interacts (page touch, navigation, scroll, submit);
  afterwards an `Agent updated · Show` affordance waits, and a parked reload
  for the mounted handle runs once from Show. Back has one
  owner: WebView history first, then Agent on compact; wide without history
  falls through to normal session navigation. iOS swipe back/forward
  gestures are enabled. No transition animation on switches; haptic only on
  divider commit, and only when the value changed. The divider drags on the
  UI runtime against absolute pane widths with no per-frame React state;
  the release crosses to RN via `scheduleOnRN`, persists the nullable
  per-device ratio (exact 0.5 included), and exposes increment/decrement
  accessibility actions. Wide auto-selects an incoming Browser `beside`
  offer beside the Agent without moving keyboard focus; compact stays
  dock-only until tap, and direct offers mount only while approved.
- **Honest Code.** `code open` versus `code diff` is now an explicit
  `destination: 'file' | 'diff'` on the offer, set by the broker from the
  invoked command and preserved end to end instead of inferred from a
  revision string (which also fixes `visible()` overwriting the numeric
  `revision` with the revision text). The dock says Code ready; a file
  destination opens the existing native file viewer in file mode at the
  exact path/line/column, a diff destination with a path opens that same
  viewer in diff mode via an explicit bounded `mode` route input, and a
  targetless/root diff opens the Changes review destination of the exact
  provider that made the offer -- never the first claimant, never an
  unrelated plugin -- after validating its declared native Changes screen,
  and fails visibly when that mapping is absent.
  Nothing is duplicated, nothing edits, review stays review-only.
- **Entries.** The developer Web Surface stays behind dev mode and renders
  through the shared hardened view. Every session dock carries a trusted
  native Browser entry that opens an honest phone-owned blank tab with no
  PTY. Capability routing stays generic; no bundled plugin id is named in
  shipping code. Takeover, terminal, Files, Changes, History and plugin
  flows are unchanged. A stale or conflicting cwd hint is rejected, never
  silently retargeted. The declared Surface launch in
  `plugins/panes/panes.mjs` keeps the originating agent pane/session
  context and creates no shell or terminal pane. (Legacy launcher
  compatibility and its migration executor were removed on 2026-09-11.)

Green here:

- [x] `packages/contract/dist/selfCheck.js` also covers the explicit Code
  destination: open defaults to file, diff preserves diff, frames without a
  destination are malformed.
- [x] `surfaceSlice2a.test.ts` proves the broker preserves open versus diff
  explicitly, keeps the numeric revision numeric, and leaks no ids.
- [x] `hostedE2ee.directed.test.ts` proves directed frames seal under a
  recipient-confidential key an observer holding the broadcast root cannot
  read, and that observe, expired, revoked, and unknown recipients get
  nothing sealed at transmit time.
- [x] `previewTransport.test.ts` proves product leases bind their exact
  offer generation and live session (replace/close/session-move ends held
  leases promptly), renew the
  offer with the lease, keep 3000 and 4000 on different endpoints and
  origins, renew explicitly only from the holding device with approval
  re-read on every renew, die across a device-silent hour while
  surviving it with authenticated renews, and answer `standsLive` false
  immediately on approval revocation or herd session termination -- with
  the stored offer record intact, the cached check still answers true,
  which is exactly the hole the live read closes.
- [x] `surfaceGateway.test.ts` proves `worker-src 'none'` on every admitted
  page, bounded concurrent requests (over-ceiling refused before dial),
  truncated SSE ending downstream with reconnect-but-no-replay, lease
  standing re-read on every request and every upgrade (a lost lease admits
  no new work and dials nothing upstream), the standing gate awaited
  per request with zero dials on approval or session loss, cookie
  authentication synchronously first with bounded per-connection pending
  slots inside the aggregate ceiling (a thousand unauthorized requests
  cost a thousand cheap refusals with zero standing reads), and zero
  dials when the gateway closes mid-await for HTTP and upgrades.
- [x] `previewBridge.spec.ts` proves silent connections die on a first-byte
  deadline and idle ones on an idle deadline, each telling the host, while
  the bridge stays up -- plus heartbeating SSE-style streams surviving
  sweeps with zero close frames (no reconnect churn) and a clean reconnect
  after an idle close.
- [x] `attachPreviewTunnel.hosted.spec.ts` proves ordered generation-
  serialized teardown with the slot held through verified removal, that a
  stale cleanup never erases a newer attach, that a pre-aborted or failed
  attach frees the slot, that a partial install still owns its clear, and
  that an unverified removal keeps ownership, quarantines, reports, and
  frees nothing.
- [x] `surfaceOrigins.test.ts` proves v1 and exact 089-style v2 tables
  retire every loaded hostname into tombstones that are never served,
  that the distinct v3 derivation never reissues a loaded address, that
  version 3 tables with missing or malformed integrity fields fail
  closed, and that the assignment epoch is stable across restarts.
- [x] `surfaceCommandChain.test.ts` proves the full offer to fanout to
  coordinator chain: ten renewals cause zero reloads, one explicit reload
  causes exactly one, and duplicates, command-less frames, and foreign
  sessions cause none.
- [x] `surfaceRenewLoop.spec.ts` proves the device renews on a bounded
  interval while mounted, that a rejection stops the loop and tears down
  the owner, and that stopping detaches cleanly with no further traffic.
- [x] `surfaceAdmission.spec.ts` proves deletion failure is reported, and
  `PreviewSurface.spec.ts` proves attachment previews carry no global
  cookie mutation.
- [x] `surfaceSlice2a.test.ts` proves targetless code diff opens a root
  delta, reload commands progress monotonically while renewals keep theirs,
  and broker titles derive per kind.
- [x] `muxrClient.surfaceOffer.spec.ts` proves broadcast and
  exactly-directed offers dispatch after real E2EE while another device's
  frame, a tampered payload, a provider-less frame and a spoofed sender do
  not -- and that interleaved broadcast/directed sequences on one stream
  all open in order while each stream's replay and any remap still fail.
- [x] `surfaceCoordinator.spec.ts` proves monotonic admission, idempotent
  replay, close removal, scope isolation, expiry failing closed, exact-
  revision dismiss with newer revisions still appearing, name-based current
  resolution across handle replacement, command-gated reload execution
  with a monotonic max watermark (3-2-3 executes 3 exactly once; replaced,
  closed, and expired handles never execute again), and the retention cap.
- [x] `surfacePlacement.spec.ts` proves the pane decision model keeps
  constant mount keys and one attach intent across 20 compact/wide
  decisions. It proves the model, not native remount behavior, which stays
  hardware-gated.
- [x] `productSurfaceLease.spec.ts` proves the product lease names only the
  offer handle and validates the assignment like the developer path.
- [x] `surfaceLayout.spec.ts` proves the compact/wide decision, the
  50/50 and 40/60 starts, clamping against available (not full) width, both
  computed panes >=360dp at the 764dp minimum and in 914x411dp phone
  landscape, a full drag sweep holding the minima, divider-aware reclamp on
  every measured container change, and the dock rule (compact zero-offer
  silence, wide exposure of non-selected offers, keyboard hiding).
- [x] `surfaceOriginPins.spec.ts` proves first-sight pinning with remap
  refusal, global hostname collision across machines and ports, no eviction,
  epoch changes tombstoning (never deleting) ownership with genuinely-new
  hostnames only, strict stored-schema rejection of `{}` and inconsistent
  history, first-init versus lost-history distinction, unavailable and
  unwritable storage failing closed with quarantine, and tombstone plus
  quarantine survival across reloads.
- [x] `surfaceAdmission.spec.ts` proves a delayed native setter landing
  after its caller's timeout is still followed by removal, drain-waiting
  for compensation, alongside the existing deletion-failure reporting.
- [x] `attachPreviewTunnel.hosted.spec.ts` proves uncertain cleanup
  retains slot, listener, and transport with persisted quarantine and no
  release, compensates with a verified removal once the native operation
  settles, and returns blocked with everything retained when quarantine
  persistence itself fails.
- [x] `checkSurfaceTarball.mjs` packs, installs outside the checkout, and
  runs help plus a live broker call through the installed files.
- [x] Root `npx vitest run`, workspace `tsc --build`, crypto and contract self-checks, host/relay/package and
  mobile architecture guards, tooling architecture, core purity, secret
  scan, bundled-plugin guard and the CLI suite stay green.
- [x] Mobile `tsc --noEmit` carries byte-identical output at 07a027a4 and
  at this commit: 7 pre-existing TerminalView native-type errors, nothing
  from these files. The 4 failing mobile-config files (2 perf suites with
  no suite found, host/relay dist use-case architecture) fail byte-
  identically at both commits.

Deliberately deferred to physical hardware (Sol owns all runtime/build
evidence; no APK in this slice) -- physical iOS and foldable gates only:
arbitrary 127/8 binding on physical Android/iPhone (iOS must fail closed
with no shared-origin fallback); physical identity retention, IME and
selection behavior, fold/unfold transitions and hinge posture, TalkBack,
frame pacing under load, memory pressure, simultaneous Terminal/WebView
resource use; WKWebView credential installation/removal against the
selected data store and supported OS versions; and first real proof that
an offer docks, a local page attaches and survives its lease honestly,
background and revocation tear the tunnel down, keyboard/selection/scroll
behave on a phone, the divider drags on the UI thread, and HMR/SSE
reconnect honestly over a live relay.

## Revisions

- **2026-09-11 (Android QA repairs)** &mdash; Sol's signed-APK campaign
  failed two flows. **File selection**: Android's picker pauses the app
  (`AppState` `background`), and the background teardown unmounted the
  WebView -- destroying the renderer that owned react-native-webview's
  pending `onShowFileChooser` callback, so DocumentsUI's result had no
  page to land in. A live leased surface now parks *network-only* in the
  background: the admission credential is removed and verified absent,
  the relay socket closes, the lease goes back, and the loopback
  listener stops accepting (every arrival destroyed, no local HTTP
  served) while the renderer stays mounted and the port stays bound to
  this bridge so nothing else can answer at that origin under the page;
  foreground takes a fresh lease and, on the exact same origin, rebinds
  the mounted page in place (new relay socket, key and admission
  credential, no remount). A moved origin, a changed offer, an attach in
  flight, or a park that cannot verify removal takes the ordinary
  retiring path. Direct HTTPS surfaces never unmounted on background.
  Parking is transport-first and synchronous: the bridge moves its
  transport generation, stops forwarding, detaches and closes the relay
  socket and refuses every arrival before the first cookie or storage
  await, so a stalled store cannot serve a byte; every native data,
  close, error and write-completion callback is checked against the
  connection's generation and identity, connection ids are never reused
  across a resume, and tracking is removed before native destroy. A
  resume runs through the owner-generation queue and re-checks mounted,
  foreground, approved, the same offer and its generation after every
  await; stale completions release only what they acquired. A denied or
  moved-origin resume retires the renderer (awaiting the child's
  acknowledgement) before the parked tunnel and listener close. A
  foreground that arrives before the park settles schedules exactly one
  resume when it does. Resumes are cancellable: the component owns an
  abort signal created when the resume begins and aborted by every owner
  invalidation (background, revoke, replacement, unmount); the tunnel
  checks it before and after every await and before the relay socket
  opens, the bridge rebinds and the credential installs, and abort
  synchronously parks the bridge again (cancelling any hold) and closes
  any prepared relay socket, so no resumed transport crosses a
  background boundary. A relay drop, error or pairing timeout during a
  resume never ends the tunnel or releases the listener and reservation
  by itself: the resume rejects back to parked, and the owner cancels
  any held picker result, retires the renderer (child-acknowledged),
  then closes tunnel and listener, then reattaches the live offer once
  (never when it is already queued or attaching). Unsolicited closures
  of a bound surface (relay drop, error, bridge failure) follow the same
  ordering: the tunnel only parks its transport and reports; the owner
  cancels any held picker result (native acknowledgement first), retires
  the renderer with the child's acknowledgement, then closes tunnel,
  listener and reservation. A credential setter outstanding when a
  resume is cancelled or fails is settled and compensated with a
  verified removal before the surface counts as parked; resume failure
  handlers stay on the relay socket until the credential is verified.
  Uploads on selection are not solved by holding unauthenticated bytes
  (that path is gone: a parked listener refuses every arrival); the
  Android picker result is gated at its exact owner instead. A
  deterministic patch of react-native-webview 13.15.0 adds a
  `FileChooserGate` consulted by `RNCWebChromeClient.onShowFileChooser`
  (through a WebView-aware `startPhotoPickerIntent` overload) and by
  `RNCWebViewModuleImpl.onActivityResult`. Ownership is explicit, not a
  React tag: the Product Surface gives its WebView an opaque
  `nativeID` token (`muxr-surface:` prefix, unguessable) and registers
  that token with the gate for an owner generation; the patch resolves
  the launching wrapper's nativeID by walking up from the inner WebView
  and claims the launch only on exact match. A matching launch is
  OWNED: it gets its own reserved request code from a process-global,
  monotonic, never-reused allocator over `0x5300..0x5FFF` (declared in
  the patch with the audit of every fixed request code the installed
  modules use -- stock 1/3, expo-file-system 5394, expo-sharing 8524,
  expo-mail-composer 8675, expo-modules-core random codes at or above
  0x10000 -- and pinned by `verifyNativePatches`, which rescans the
  installed sources for collisions) and an immutable pending record --
  exact `ValueCallback`, its own output files -- in a process-global
  bounded map, capture disabled so the result always comes through the
  chooser; exhaustion fails closed. The Product Surface prefix is
  recognised in the patch itself, before any gate: with no gate
  installed its chooser is refused outright (capture included), never
  stock. The launch is transactional: capacity, a current Activity, a
  free code and a resolvable chooser are checked before the claim, and
  any failure to start after the claim abandons it -- exact callback
  completed once on the UI thread, pending record removed, no tombstone
  for an Intent that never started. Pending records die with their
  Activity or their owner's unregistration (abandoned through the gate,
  one null completion), and a late result for any reserved code nobody
  holds is consumed. A Product Surface token that is unregistered or
  differs fails closed (REJECTED: the page's callback completes with
  null and the owner shows a refused notice); every other WebView is
  UNRELATED with stock behaviour. One owned launch exists app-wide; a second is REJECTED
  while a launch or its tombstone is outstanding, and nothing is ever
  replaced. Results are keyed by launch id, never by callback identity.
  Release requires the same owner generation, the readiness epoch the
  owner marked after its resume was fully bound (fresh lease, relay
  socket, bridge binding, verified credential; direct HTTPS marks on
  active), foreground, and a still-registered owner; it runs on the UI
  thread and resolves with what it did, so a background that lands
  before a queued release revokes readiness synchronously and the
  release delivers nothing. Cancel carries the owner generation (an old
  owner's cancel never touches a successor) and is acknowledged
  asynchronously with an explicit outcome -- a native failure rejects,
  never reads as "nothing pending": a held result is discarded, a launch
  still out becomes the one non-evicting tombstone whose late result is
  consumed once (null) and never stock-delivered; a result for an
  unknown reserved code after activity recreation is consumed the same
  way. Every retirement -- replacement, unsolicited closure, lifecycle
  cleanup, resume failure -- is one generation-scoped primitive: it
  captures the tunnel, owner generation and attempt, fences the captured
  transport synchronously, awaits the exact-generation chooser cancel,
  and re-verifies after that await that the captured tunnel and attempt
  are still current before retiring the renderer (with the child's
  acknowledgement) and closing the tunnel (listener, reservation,
  verified credential); a successor bound meanwhile is never touched.
  Overlapping retirements of the same surface coalesce into one shared
  promise: a replacement, closure or cleanup that meets a retirement in
  flight awaits that same completion -- the child's unmount
  acknowledgement included -- and only then revalidates and admits a
  successor; a superseded outcome admits nothing until a retirement
  completed. A native cancel rejection is not a discard: the captured surface stays
  quarantined (transport fenced and parked with the credential removed
  and the lease returned, renderer mounted, origin and listener held)
  behind an actionable notice; the quarantine gates every resume entry
  and continuation (scheduled resume, foreground settle, each await of
  a resume, readiness, release, renewal, successor admission), and
  lifts only once an exact-generation cancel is acknowledged and the
  renderer's retirement completed, or the surface unmounts. After the
  chooser release, renewal starts only when native acknowledged
  (`delivered` or `nothing`) and the owner still stands -- foreground,
  mounted, same tunnel, offer, lease and readiness epoch -- so a
  background or unmount during the release leaves zero renewals. A malformed or over-budget relay
  frame, a resume/socket error, a timeout or a failed compensating
  credential removal only parks transport and reports; the tunnel is
  never ended under a mounted renderer. A discarded selection is
  announced in a polite live region and cleared by the next fresh
  attach. No URI or result bytes enter JS or logs; iOS keeps its
  in-process picker. `verifyNativePatches` pins the patch and the gate
  wiring; the gate's JVM tests cover late results after cancel and
  recreation, overlap, queued release then background, and an old
  owner's cancel against its successor.
  **Relay restart**: the relay-layer half is reproduced with the real
  relay process (SIGKILL, persisted local authority, a real paired
  device and a machine enrolled through `MachineAuthority` whose
  tickets arm the machine-credential revalidation): reopened preview,
  machine and both control sockets survive 75 s past the first
  credential tick with no 1008 and no close, so the relay's credential
  revalidation is not the closer; the host's lease authority has no
  relay-connection dependency. The device bug is not claimed fixed
  until the signed APK rerun. The
  device-observed second loss (`could not reach the relay`, i.e. a
  socket error rather than a close frame) is not reproduced host- or
  relay-side and remains a device-path finding to trace with relay and
  adb logs captured together.

- **2026-09-11 (legacy compatibility removed)** &mdash; Product decision:
  there are no live users of the Terminal Browser / Tode launcher
  packages, so the compatibility sources, migration executor and journal,
  PATH-alias shims, `terminal-code` launcher, compatibility diagnostics,
  and their tarball/CLI-test hooks are deleted rather than repaired. Only
  the first-class `muxr.browser`/`muxr.code` plugins, their Tools entries,
  and the `muxr browser|code|surface` CLI remain; Tools entries still open
  offers through the broker without creating terminal panes. Earlier
  revision notes below that describe migration, aliases, or shims are
  history, not shipped behaviour. Also in this revision: the approval
  store itself now owns a synchronous authority fence that moves before
  any persistence starts, standing/renew/revalidate capture their
  authority token before the first catalog or session read, and a
  replacement attach awaits the WebView child's own unmount
  acknowledgement before any close, release, rebind, or install. Fenced
  or unreadable approval authority (a mutation whose persistence is
  still running) closes the exact current holder on the next
  revalidation -- established forwarding stops without waiting for
  persistence, renew denies, successors are never closed by stale work.
  Queued replacement work carries an owner generation moved by unmount,
  background, approval loss, renewal loss, and renderer death, and is
  re-checked (mounted, foreground, approved, current offer) before it
  runs, after renderer retirement, and before any lease or credential:
  cancelled work creates no controller, lease, listener, cookie, or
  WebView. One retirement promise per renderer generation is shared by
  every waiter and settled by the single child unmount acknowledgement,
  so an overlapped detach never stalls the queue. Approval mutation is
  event-driven: the approval store publishes a synchronous mutation-start
  hook keyed by exact device and plugin; the dispatcher routes it to the
  lease registry, which ends the current holders standing on that
  (device, provider) in the same event turn -- while any catalog or
  session read is still pending and before persistence -- and the fence
  revision is per (device, provider), device-wide only for leases
  without a provider, so an unrelated plugin's mutation never closes a
  Browser surface. Duplicate re-follows are coalesced (a queued final
  revision is not enqueued twice), and foreground is read from
  `AppState.currentState` at mount so an offer arriving while
  backgrounded creates no listener, tunnel, or cookie until foreground.
  Provider scoping: a product lease stands on the exact selected
  provider's identity (`pluginId:manifestHash`) within the catalog, not
  the whole approved digest -- admission, standing, renewal and
  revalidation compare that identity and the per-(device, provider)
  approval fence, so an unrelated plugin's enable, revoke, or manifest
  change never closes or denies a Browser surface, while the provider's
  own approval or manifest change closes it promptly and unreadable
  authority fails closed; developer leases keep the whole-digest
  comparison. A redundant approve of an unchanged value is not a
  mutation and ends nothing. Foreground resume happens only after an
  actual background transition, so an iOS inactive-to-active blip during
  a replacement never doubles the attach. Approval writes are ordered
  per (device, provider) through one mutation queue: the fence reads in
  flux from enqueue to settle, an unchanged-value no-op is decided only
  inside the queue after earlier writes settled, the mutation-start
  invalidation fires before the changing operation's first await, and
  no lease is issued for a provider whose approval is pending. Catalog
  generations are monotonic and event-driven: a `plugins.invalidated`
  frame naming plugins advances each named provider's generation and
  ends its current holders at the hook, as part of the authority token
  captured before reads and compared before any dial or extension,
  while an unrelated provider's frame leaves a Browser token untouched.
  An empty frame is informational by contract (reconnect
  reconciliation, an unnameable change): it refreshes cache bookkeeping
  only and never moves authority or ends a holder; an actual provider
  change surfaces through the exact provider identity on the next
  catalog read. The catalog diff owner also delivers every changed
  provider id to the lease authority directly and synchronously before
  the bounded wire frame goes out, so a change too large for the wire
  to name (more than 32 plugins) still fences the Browser provider:
  paused admissions get zero dial and its holders end immediately, with
  unrelated providers untouched. The attachments watcher names the
  bundled attachments plugin (id read from its own manifest) in its
  frame; if that manifest cannot be read it sends the empty
  informational frame and logs the cause locally, so phone cache
  reconciliation is never silently lost and lease authority is never
  touched.

- **2026-09-11 (fifth closure repair)** &mdash; Astra's remaining
  1076622a and 268c13fc findings and Fable's overlapping hazards.
  Standing: the dispatcher owns monotonic authority tokens -- the
  catalog token moves on every approval write, plugins-invalidated
  frame, and observed digest change; a session token moves on every
  herd session event, tree connectivity flip, and observed liveness
  change. `standsLive`, `renew`, and `revalidate` capture the lease,
  holder generation, and token, read approval and session together,
  then compare lease identity, holder generation, expiry, exact device
  authority, offer generation, and the token synchronously before any
  dial or extension; a moved token denies without extension, and every
  asynchronous invalidation is guarded by the captured lease and holder
  generation, so stale work never ends a successor. Continuous
  authority is fail closed: an unreadable or disconnected herd ends
  existing holders, stops forwarding, and denies renewal; a Herdr
  restart under an active page therefore ends the surface with Reopen,
  and a fresh attach reconciles once the herd is readable. Dirty
  recovery: a blocked same-owner origin is reconciled only through the
  attach layer's ownership hook -- refused while any in-process
  lifecycle owns it (cookie, mark, listener untouched), awaited while a
  same-origin teardown is verifying, otherwise cleared on the
  generation-checked cookie queue; every granted lease is pinned
  against the full machine/endpoint/epoch/origin tuple, and a lease
  whose pin refuses is released before the refusal propagates, so
  refused taps leave no orphan leases. A same-endpoint revision retires
  the mounted renderer and tunnel in order and reattaches on the
  replacement lease -- the host binds a tunnel to one exact offer
  generation, so the old tunnel is never retained under a replaced
  offer and its close callback stays authoritative; the interaction
  policy is unchanged (follow before interaction, one parked Show
  after). Host origins: historical hostnames canonicalize with WHATWG
  URL IPv4 semantics (`127.96.050.25` retires `127.96.40.25`) across
  v1/v2 assignments and tombstones. Migration: every alias mutation
  journals a pending intent (final path, prior absence, diversion,
  complete expected shim bytes and hash) before the diversion or any
  write; the shim is published atomically (same-directory temporary,
  fsync, chmod, rename -- the final path is never truncated); rollback
  enumerates intents, diversions, and installed entries alike, removes
  a complete, empty, or partial shim and restores the diverted
  original's exact bytes and mode or its absence, and reports a foreign
  replacement as an incomplete rollback rather than success.

- **2026-09-11 (fourth closure repair)** &mdash; Astra's seven e9477f05
  findings and Fable's two lifecycle blockers, repaired with no new
  transport. Standing: the final pre-use check re-reads holder
  generation, expiry, exact device authority, offer generation, and a
  connected-and-reconciled session with no await after the last live
  read; a superseded generation answers false without ending its
  successor; a disconnected Herdr tree is `unknown` -- requests are
  denied (503) and renew reports without extending, but nothing ends
  until the herd confirms. Gateway: reservations stay charged until the
  standing work settles (close only cancels), WebSocket handshakes dial
  inside the active-request budget, and a downstream close destroys the
  pending upstream handshake. Pins: a failed epoch-rotation write restores
  all four maps byte for byte; existing and migrated tables write the
  durable init marker before admission; tombstones validate canonically;
  a blocked (dirty or quarantined) origin whose owner returns after a
  restart is reconciled through a verified compensating removal instead
  of refused forever, and a removal that cannot be verified re-quarantines
  durably. Lifecycle: unmount closes the parked tunnel synchronously
  (never awaiting an effect that cannot run again) so the app-wide slot
  frees within a second; approval loss, renewal loss, and background
  retire the renderer through the acknowledged path and close exactly
  once. Host origins: one canonical IPv4 validator for assignments and
  tombstones across every schema, and a provably noncanonical legacy
  hostname tombstones its browser-canonical twin. Migration: an exposed
  entry point without a packaged shim refuses in preflight; rollback
  restores every journaled diversion even with `installed: []`; every
  recorded owner, enabled or disabled, is verified against its exact
  source, path, pinned revision, and version before any enabled-state
  change. Broker: targetless `code diff` binds to the canonical worktree
  boundary (Changes), while explicit targets still resolve from the
  validated invocation cwd.

- **2026-09-11 (third closure repair)** &mdash; Astra's eight further
  production-path findings plus Fable's epoch-recovery blocker, repaired
  with no new transport: post-await rechecks of lease, holder generation,
  offer, session, and approval with immediate holder invalidation and a
  connected-tree session gate; transactional pin preservation, durable
  init marker, canonical IPv4, and prior-schema migration; async
  renderer-retired acknowledgement, dirty-origin tracking with settle
  compensation and retained-everything quarantine failure; malformed
  legacy tombstoning plus epoch-salted v3 derivations yielding new
  hostnames after table loss; shipped terminal-code launcher with
  exposure-independent detection and preflight refusal; diverted-map
  alias recovery, exact source/version verification, and pinned-commit
  preflight; gateway sync-cookie-first ordering with bounded pending
  slots, close cancellation, and post-await ownership rechecks; single
  canonical broker boundary with preserved invocation cwd for relative
  Code targets. Only physical iOS/foldable gates remain.

- **2026-09-11 (second closure repair)** &mdash; Astra's seven
  production-path findings and Fable's subdirectory regression repaired
  with no new transport: `standsLive` re-reads exact-device approval and
  the live herd session generation on every gateway request, upgrade,
  post-attach check, renew, and revalidate -- never from a timer cache;
  epoch changes tombstone hostname ownership instead of deleting it, with
  strict pin schema, fail-closed storage, first-init versus lost-history
  distinction, and persisted quarantine; native cookie ops tracked to
  their own callbacks with renderer-retired detach ordering and delayed
  setters still followed by removal; pre-fix v1 and v2 (089-style)
  assignments retired under a version 3 table and v3 derivation; reload
  watermark as monotonic max with dead-handle retirement, pending commands
  separate from navigation handles, and identical interaction policy in
  both Browser modes; compatibility launchers normalizing the trusted
  plugin-context JSON with alias resolution verified and packaged-only
  shims; migration preflight for local/path owners, exact
  enabled/disabled rollback that continues remaining entries, and
  journal-before-divert with retry preservation; broker subdir/descendant
  cwd acceptance through canonical realpaths. Only physical iOS/foldable
  gates remain.

- **2026-09-11 (closure repair)** &mdash; Astra's closure (8 original
  blockers + 2 regressions) and Fable's closure (3 UX blockers) repaired
  with no new transport: exact receiving-device approval and live session
  generation enforced on every renew, gateway request, upgrade, and
  post-attach recheck; global fail-closed origin pins with no eviction,
  serialized persistence, quarantine, and an authenticated host assignment
  epoch for recovery; ordered teardown holding the slot through verified
  removal with pre-abort safety, record-before-install, bounded native ops,
  and generation-guarded stale cleanup; v1 hostnames tombstoned with a
  distinct v2 derivation; device-driven 4-minute renew with acknowledgement
  and full-owner teardown; the declared Tools Surface launch (original
  agent context, no shell pane) with packaged compat sources, executor,
  aliases, and terminal-code absence proof; monotonic reload commands with
  the ten-renewals-zero/one-reload-one chain proof; conditional dock with
  wide offer exposure and the blank entry in the session overflow; strict
  broker cwd rejection; locked, journal-first, participant-only migration;
  WebView-scoped follow mode, user-safe teardown copy, the autofill
  caveat, and heartbeat-proof idle sweeps. Only physical iOS/foldable
  gates remain.

- **2026-09-10 (final repair)** &mdash; Independent final review closed
  fourteen security findings and nine UX blockers with no new transport:
  recipient-confidential directed keys with send-time standing; leases
  bound to exact offer generations with authenticated renewal; per-service
  endpoint identity with origin retirement and phone-side pins; synchronous
  slot reservation with generation-serialized cookie teardown;
  `worker-src 'none'`; attachment previews without global cookie mutation;
  device deadlines and gateway ceilings; upstream abort propagation; tarball
  packaging with an installed smoke; compatibility migration proven through
  the live action path (broker hop deferred on this machine's predating
  installed CLI); monotonic reload commands with same-endpoint navigate;
  provider-routed Code destinations; Agent-full-width with reclamp;
  Modal-anchored overflow, safe-area-correct chrome, keyboard-aware dock,
  background-only teardown with same-origin resume, touch interaction,
  honest address behavior, derived labels, and offer renewal. Baseline
  evidence re-recorded; only the previously recorded identical failures
  remain.

- **2026-09-10 (Slice 2B review)** &mdash; Sol's product blockers, fixed
  with no new scope. Directed/broadcast replay now keys on the
  authenticated recipient with legacy broadcast adoption; selection keys on
  the logical surface name with stable child keys and pending-update
  behavior for local and direct alike; back has one explicit owner with
  iOS gestures; the tree keeps one stable identity with absolute hidden
  panes and a decision-model continuity check; the divider uses
  `scheduleOnRN`, absolute widths, a nullable ratio and accessibility
  actions; chrome is compact with an editable address, overflow menu and
  explicit foreign-link choice; foreground reattaches and provider loss
  hides Reopen; Code diff paths open the viewer in diff mode and root diffs
  open the session Changes destination; wide honors `beside` without focus
  theft. Baseline evidence recorded: identical mobile-tsc and vitest
  failures at 07a027a4 and here.
- **2026-09-10 (code diff opens)** &mdash; Targetless `code diff` is an
  opening command again: it creates-or-replaces the named root-delta Code
  offer instead of requiring an existing one. `browser update` keeps
  refresh semantics. Proven by a live broker/standalone-CLI child-process
  check plus broker create-or-replace coverage.

- **2026-09-10 (Slice 2B)** &mdash; Mobile product integration on top of the
  2A contract with no new transport: directed E2EE offers, the bounded
  coordinator, product lease/request ownership, the shared hardened view,
  the adaptive workspace, explicit Code destinations and the blank Browser
  entry. Two corrections rode along: Code destination travels explicitly
  (and `visible()` no longer overwrites the numeric revision with the
  revision text), and directed native frames authenticate for the exact
  grant recipient under the broadcast root. No APK, no emulator, no iOS
  claim; runtime proof stays with Sol.

- **2026-09-10 (Slice 2A review fixes, round 2)** &mdash; Two final blockers, fixed with no new scope. Reconnect replay ran only on host-link-open: a phone rejoining an already-connected host now replays current exact-session offers directed only to itself from the authenticated `client.hello` path, filtered exactly like a live send. Provider selection for direct and Code offers was checked then discarded: every materialized offer now carries its host-resolved claimant (explicit or sole-installed, ambiguity failing visibly), the frame guard rejects provider-less offers, and the mobile admits only while that exact provider stays approved and claiming. The client-to-host `surface.offer`/`surface.list`/`surface.close` requests and their handlers are removed: no product path needs them, and they let a phone inject offers into other controlling devices. Mobile needs `preview.lease` and `preview.release` in this slice.

- **2026-09-10 (Slice 2A review fixes)** &mdash; Independent review found six blockers, all fixed here with no mobile scope. The broker wrote offers nothing could observe: every open/update/reload/close now emits a bounded typed `surface.offer` HostFrame with the handle, exact session, revision and operation, directed only at live control devices over the existing encrypted relay send path (local/dev broadcast as before), with reconnect replay of current offers; reload and target-less update are accepted and re-emitted, never visible. Broker context binds the exact live agent session (shell, stale, moved and same-cwd-ambiguous all fail). Product leases validate the receiving device's live approval of the offer provider, and approval state is in the lease snapshot so revocation closes held tunnels. `surface capabilities` reports honest installed availability and ambiguity, and direct/Code offers require an installed claimant. Compatibility sources were rebuilt from the actual installed manifests: the real `open-split` action ids/titles/contexts with executable handlers, arg-faithful binary shims, an honest `about:blank` home for no-target browser opens, and a corrected CLI `--` separator.

- **2026-09-10 (Slice 2A)** &mdash; Surface offer contract, host-local broker, CLI, product-lease authority and compatibility sources landed with no mobile presentation. Product `preview.lease` now consumes a current local Browser offer handle and resolves its endpoint from host-owned offer state; phones no longer submit product ports, providers or contexts. Provider resolution is generic over manifest-declared claimants with the packaged `muxr.browser` claimant and `surface.code.open` on native `muxr.code` (`files.read`) as the in-tree claimants. Compatibility replacements for `zenbu-labs.terminal-browser`, `zenbu-labs.tode` and `open-split` exist as versioned sources plus serialized migration/rollback metadata only; installed packages are untouched. Durable surface-origin assignments are bounded at 256 and refuse past the ceiling without recycling hostnames.

- **2026-09-10 (Slice 1b review fixes)** &mdash; Independent review of the slice above found four blockers, all fixed here with no product-scope broadening. The admission install used `setFromResponse`/`get`/`clearByName` without WebKit selection, which on iOS writes Foundation's store while the WKWebView sends only the default `WKHTTPCookieStore`: every iOS admission failed even with the bind held. Install, read-back and clear now address the WebKit store on iOS (flag ignored on Android) with a domain-less, `HttpOnly`, `SameSite=Strict` cookie that stays host-only on the IP literal. The gateway now emits one exact-origin content policy on every admitted page -- same-origin fetch/EventSource/worker/WebSocket/frame/form traffic kept, plain-HTTP/plain-WS off-origin (including alternate ports on the numeric host) failed closed, external HTTPS/WSS kept -- kept alongside upstream enforcing policies it cannot be widened by, with report-only policies and reporting channels dropped. The truncated derived origin is now only the allocator's first choice: the host allocates each endpoint's hostname once, persists it append-only under its data directory (atomic 0600, corrupted/unwritable fails closed), moves collisions to a free hostname, returns the same assignment across reattach and restart inside the encrypted lease result, and pins attach to the lease's stored assignment trusting no device-supplied Host or origin. The 127/8 bind still fails closed with no fallback of any kind. Legacy v1 takeover is untouched.

- **2026-09-10 (Slice 1b)** &mdash; Local admission landed. The tunnel no longer reaches the dev server: it reaches a lease-owned HTTP/WebSocket gateway on the host, written on node's own parser, which authenticates every request and every upgrade on a reserved cookie before it dials anything. Compiled mobile mints an independent 256-bit credential per attach, sends it only inside the encrypted `preview.attach` request, and installs it as a host-only `HttpOnly` `SameSite=Strict` cookie in the WebView's own store -- through the platform's `Set-Cookie` parser, because the structured setter emits a `Domain` and a `Domain` on an IP host is the one case Chromium rejects. Each endpoint now gets a private numeric 127/8 address derived from an opaque endpoint fingerprint the lease returns, stable across reattaches and distinct between endpoints, since cookies ignore ports and a shared hostname is a shared jar. The device binds that address before the credential is installed, fails closed with no fallback if it cannot, clears the credential before it releases the address, and holds one surface app-wide because Android's WebView cookie store belongs to the process. `@react-native-cookies/cookies` was evaluated and rejected: deprecated since 2022 and AGP-8 incompatible; `@preeternal/react-native-cookie-manager` is the maintained continuation and is what shipped. Two structural risks are stated rather than fixed: same-site is per host and not per port, so script inside the surface can hand the credential to a local listener on another port of that address; and a stable origin keeps service workers and storage across attaches, which a per-endpoint WebView profile would close and `react-native-webview` does not expose. Legacy takeover keeps v1 framing, port attachment and `127.0.0.1` binding untouched.

- **2026-09-10** &mdash; Runtime QA on the first Slice 0 build failed closed with `preview: relay ticket required` on a valid hosted pairing. The shared preview attach helper read only the connection-settings token, which is empty in hosted mode because the scoped credential and its relay live on the Device grant. It now resolves the ticket input from that grant, refreshes it before use, and fails closed with an actionable message when the grant is missing, expired or for another computer. Local and self-host ticket behavior is unchanged, and the resolution happens before `preview.attach` so a ticketless device no longer leaves the host joined to an abandoned channel.

- **2026-09-10** &mdash; The next device run paired and opened the listener but the WebView reported `net::ERR_EMPTY_RESPONSE`: request bytes reached the fixture, response bytes never reached the phone. Two return-path defects in `previewBridge.ts`, both invisible to a Node stand-in. React Native defines no global `Buffer`, so `connection.write(Buffer.from(...))` threw and the catch closed the connection with zero bytes; the bytes now go to `react-native-tcp-socket` as the `Uint8Array` it already accepts. And `destroy()` runs on the module's shared executor while writes run on the socket's own, so closing on the host's close frame dropped the response that was still queued; the socket is now destroyed from the last write's completion callback. Unreadable binary frames tear the bridge down instead of being skipped, since a multiplexed stream cannot drop one and still promise exact bytes. Wire framing is unchanged.

- **2026-09-10 (Slice 0 verdict)** &mdash; Browser passed on the emulator. Code hit its approved kill criterion: finger selection cannot cross lines in Monaco, no native selection handles exist, and IME focus was intermittent; both open upstream issues confirm the platform behavior. All Code Surface work stops with no fallback, and this spec is narrowed to Browser.
- **2026-09-10 (Slice 1 flow-control correction)** &mdash; Review of the corrections below found that the host half never made it in as written: `deliver` called `socket.write(payload)` with no completion callback and sent the credit on the next line, so the device→host direction credited on arrival. That is not a smaller window, it is no window: the device refilled instantly and could queue without bound in the host process, and the commit message's claim of "credits tied to completed writes" was true only of the device half. The host now credits from the write callback and counts writes in flight. The same audit found the symmetric truncation on that path -- a close frame ran `drop()`, which destroys the socket and discards whatever node still held, so a browser closing mid-upload truncated the request body. The host now drains accepted bytes before it ends the upstream, exactly as the device already did for responses. The device's unsent backlog gained an explicit per-connection and aggregate ceiling, since `pause()` there is asynchronous across the native bridge. `attachPreview` gained an injected `dial`, defaulting to the loopback dial and never passed in production: on this machine the kernel absorbed sixty-four megabytes into a peer that read nothing, so a withheld write completion is not a state a test can create with a real socket.

- **2026-09-10 (Slice 1 corrections)** &mdash; Independent architecture review and a signed-Android run found the first Slice 1 pass incomplete, and a device origin still accepting connections after relay and host death while the page reported the socket open. Five root causes, all fixed here. Lease authority used "not recorded as view-only", which reads a removed grant as permission; it now needs an explicitly live, unexpired control grant, and an authority or catalog read that fails counts as no. Attach validated the lease before its awaits and registered ownership after them, so a release, an expiry or a retry mid-attach could leave an orphan tunnel; ownership is now claimed first, revalidated last, and every rejected or superseded transport is closed. The device installed its relay close and error handlers only as startup rejecters and never reinstated them, so remote death tore nothing down; one idempotent owner now covers relay close, relay error, bridge failure, timeout, screen cancellation, a late-arriving bridge and the caller's own close. Mobile backpressure paused the WebView socket, which cannot slow a sending host; both ends now run authenticated per-connection credits tied to completed writes, with bounded frame size and bounded outstanding bytes in each direction, control frames always deliverable, and a closing connection draining what it was credited rather than truncating it. And a fixed ten-minute TTL killed live surfaces mid-read; a held lease that still passes every check is now renewed instead, bounded by those checks and by the device grant's own expiry. Product leases additionally record access, provider and context, so an arbitrary port stays an explicitly developer-only diagnostic. Legacy takeover keeps v1 framing, port attachment and its old backpressure untouched, and the Surface still fails closed when a host will not confirm v2.

- **2026-09-10 (Slice 1)** &mdash; Transport hardening landed: versioned authenticated framing with per-direction sequences through one shared codec, host-registered endpoint leases replacing caller-chosen ports on the product path, bounded connections and queues with pause, resume and explicit overflow closes across device, relay and host, and deterministic teardown on unmount, expiry, revocation and disconnect. Legacy takeover keeps v1 framing and port attachment untouched.

## Confidence

High on the architecture and the reuse boundary; Slice 0 settled the open question by killing Code rather than by guessing. The remaining risk is runtime, not design: the hardened transport is proven in focused flows here and still needs a device and a live relay to be believed.
