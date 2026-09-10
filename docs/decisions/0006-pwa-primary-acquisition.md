# 0006 — PWA-primary acquisition and installed-browser grants

Tier: T3 (credential storage and command authority)
Status: implemented
Date: 2026-09-10
Decider: Umer
Amends: 0003 (reconciles shipped browser control semantics; 8h default retained)

## Context

Record 0003 says browser grants are read-only observation grants with terminal
mutation native-only. The shipped system mints owner-confirmed control browsers
(`muxr pair --browser`, eight-hour TTL, single-controller takeover shared with
phones) alongside view-only browsers (`--browser-view`). The T3 record no
longer matched production — the review's biggest governance finding.

The approved product position is: the PWA is the primary *acquisition* surface
(demo without install, first pairing in the browser the user already sits at,
the only open path for new iPhone users); the installed PWA becomes co-primary
only after the gates below; native remains for background voice, mDNS/LAN,
preview/takeover, and other native-only features.

## Decision

1. **Docs agree with shipped control semantics.** An owner-confirmed browser
   grant may be `control` (`--browser`) or `observe` (`--browser-view`).
   Default TTL stays eight hours for both; refresh re-clamps; revocation
   closes sockets, rotates the machine data key, and now also drops web-push
   and Expo subscriptions for the revoked device.
2. **Explicit personal installed-browser grant.** `muxr pair
   --browser-personal` mints a 30-day renewable-by-repairing control grant for
   the operator's own installed browser. The longer TTL applies only when the
   stored device record carries the explicit `personal: true` marker minted
   through the centralized pairing intent; the host refresh clamp honors the
   marker and nothing else. The 8-hour default is unchanged everywhere else.
3. **Authority is never inferred from installed display-mode.** Standalone
   vs. tab only picks install UX ordering (iOS Safari must install *before*
   claiming because IndexedDB does not transfer; Android/desktop pair first,
   install after). Every browser grant is minted, consented, and revocable
   through the same machinery.
4. **Push actions are deep-link only.** The service worker never holds a
   reusable credential and never injects y/n. Notification taps (including
   the Review/Open buttons) open the blocked request, where approval runs
   under the real device grant. Synthetic relay answers stay rejected with
   E2EE on (HTTP 410).
5. **Funnel order.** When web hosting is on, setup pairs phone and browser
   together (no either/or fork); the owner's own browser is a first-class
   first contact. Install is never prompted on the public demo origin.

## Failure cases

- Shared/personal browser rides an unlocked session: bounded by TTL, idle
  lock, explicit revocation, and the WebCrypto-wrapped IndexedDB store (still
  not SecureStore-equivalent — live XSS can ride an unlocked session).
- Agent-controlled Mermaid/SVG/ANSI-hyperlink content executes script: bounded
  by the shipped strict CSP; verification artifact G5 blocks any move of the
  *default* to control or durable.
- iOS IndexedDB eviction deletes the wrapping key: the client surfaces a
  graceful re-pair screen instead of a dead icon.
- Tailnet rename/MagicDNS change orphans installed PWAs and push subs:
  `muxr doctor` reports advertised-origin drift; docs say re-pair browsers.
- Personal grant on a shared machine: the flag copy names it for the
  operator's own installed browser; revocation is one command.

## Rejected

- Inferring a durable grant from `display-mode: standalone`.
- Granting the service worker a reusable terminal credential or faking
  approval by injecting y/n from push actions.
- Serving the real PWA from a canonical hosted origin (breaks the
  code-publisher trust property: the client a user runs is pinned by the npm
  package they installed, served from their machine).
- Workbox/offline-shell machinery (Chrome hasn't required a SW for install
  since 108; the manifest was the gap).

## Rollback

The existing server capability flag disables web pairing and returns 404
without a client release. Rollback revokes all browser devices (personal
included), closes their sockets, rotates machine keys, drops their push
subscriptions, and serves an unregistering service worker if one was deployed.

## Executable verification

- `scripts/setup/domain/dist/selfCheck.js` asserts the 8h default, the
  explicit 30-day personal TTL, marker round-trip through
  `pairingIntentFromDevice`, and the unchanged `--browser` default.
- `scripts/diagnostics/application/checkWebPush.mjs` proves subscribe with
  deviceId+level, level-filtered delivery on `blocked`, and revocation
  unsubscribes (G2 diagnostic).
- `scripts/diagnostics/application/checkWebExport.mjs` proves installability
  metadata, delivery headers, secret hygiene, and the Whisper-model guard (G6).
- Browser QA (NEW-USER-SMOKE step 4b) proves install-before-claim on iOS,
  pair-then-install on Android, resume-to-live < 3s (G3), and the XSS artifact
  (G5) before any default change (G1/G4).

## Open gates (not decided here)

- G1: whether the *default* browser TTL or control-by-default may move.
- G4: install reliability matrix across iOS point releases.
- G5: executed XSS verification under the shipped CSP.
