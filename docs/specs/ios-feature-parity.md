---
title: iOS feature parity
slug: ios-feature-parity
status: implemented
created: 2026-09-07
updated: 2026-09-07
owner: umer
links:
  - ~/.muxr/attachments/pane/w1FE:p1S/ios-parity-inventory.md
---

## Context

**Everything in this section describes the baseline this work started from, not how the app behaves
now.** What replaced it is under each unit below.

Android and iOS had drifted in one specific area: the ongoing status surface. The audio half of the
voice overlay was implemented in source on both platforms, but every notification and service
function in the iOS native module returned a constant, so nothing on iOS showed that agents were
working.

The platform-agnostic bridge for that surface already existed. `updateVoiceNotification`,
`clearVoiceNotification` and `addVoiceNotificationActionListener` in
`apps/mobile/modules/voice-overlay/index.ts` are the API both platforms are meant to implement, and
`KernelNotifications.tsx` already drove them. iOS declared the `onNotificationActionRequested` event
and never sent it. So this filled an existing seam rather than designing a new one.

This spec tracks the whole workstream. Mac's native commits are integrated. The current integration
is `09c1f405`, which adds tested host reconnect rect and placement-ID/delete corrections: the real
flow passes 4 of 4, the build passes, and CI passes in full.

## Workstream and ownership

| unit | owner | branch | status |
|---|---|---|---|
| 1. Settings live-updates capability gate | frontend | `feat/ios-feature-parity` | implemented, runtime verified |
| 2. Native Live Activity `HerdLiveActivity` | Mac | integrated | implemented, simulator verified |
| 3. Mute and stop intents | frontend + Mac | integrated | implemented, simulator verified |
| 4. Terminal show, hide and `autoShowKeyboard` with shared gates | opus-verification | integrated | implemented, one case environment-blocked |
| 5. Extension signing and export guards | opus-verification | integrated | implemented, native acceptance pending |
| 6. Kitty graphics runtime | Mac | — | RGBA f32 accepted on the current host |

All simulator results below were taken on an iPhone 16 Pro simulator. No physical device has been
used, so nothing here claims device audio, APNs, or remote Activity behaviour.

## Unit 1 — Settings capability gate · implemented, runtime verified

`SettingsView.tsx` gated the Live agent updates row on `Platform.OS === 'android'`, so the row could
never appear on iOS even once the capability existed. The gate is now the native capability itself:

- `promotedNotificationsSupported = supportsPromotedNotifications()` — the native module decides,
  per OS build, whether a live status surface exists.
- Copy is chosen per platform by `liveUpdatesCopy`: iOS names the Lock Screen and Dynamic Island,
  Android keeps its existing status-bar island wording verbatim.
- The existing `AppState` resume listener already refreshed the enabled flag; with the platform gate
  removed it now refreshes on iOS too.
- The row's action stays `openPromotedNotificationSettings`, which iOS now answers: the native
  implementation is integrated.

Android behaviour is unchanged: `supportsPromotedNotifications()` there is the same real capability
check that previously sat behind the platform test, and the Android strings are untouched.

Verified on Mac's normal build `74891c84`: the row is visible and on — **pass**. Its full
accessibility subtitle names the Lock Screen and the Dynamic Island; the visual label truncates,
which is presentation only and does not change what the row reports.

**The destination is limited.** The action uses the public `openSettingsURLString`, and in the
simulator the tap lands on Apple Settings' Apps list rather than muxr's own detail page. The tap
also grants no permission by itself. So the row opens Settings, and nothing more should be read into
it than that.

## Unit 2 — Native Live Activity · implemented, simulator verified

Target `HerdLiveActivity`, bundle identifier `com.trymuxr.app.activity`, **no App Group**. Root
verified the requirements against official ActivityKit documentation.

Fills the existing bridge rather than adding API. Each function below is implemented; the baseline
constant it replaced is noted where it matters:

- `updateNotification` → start or update the activity, from the seven scalars the bridge already
  passes (`mode`, `count`, `names`, `eventKey`, `voiceState`, `voiceName`, `muted`).
- `clearNotification` → end the activity.
- `supportsPromotedNotifications` → report real Live Activity availability, which is what makes the
  Settings row from Unit 1 appear.
- `canPostPromotedNotifications` → report the real authorization. In the baseline it returned `true`
  on iOS while `supportsPromotedNotifications` returned `false`, so the module claimed a permission
  it could not honour. Both now report real state.
- `openPromotedNotificationSettings` → open the app's iOS settings page.

No App Group is needed: the activity renders `ContentState` delivered by ActivityKit and the bridge
already passes the complete content model, so nothing requires shared storage.

Tap routing uses `widgetURL` with the existing `muxr` scheme and the already-entitled
`applinks:trymuxr.com`, and **opens the app to its overview, not a specific session**. The bridge
payload carries no session route: `eventKey` is a dedupe key of the form `mode:ids` that can cover
several agents at once, and it is an internal id the product never surfaces. Deep-linking a session
would need a route added to the payload first, so a wrong-session deep link is not a risk here and
correct-session routing must not be claimed as a requirement this design meets.

Verified on an iPhone 16 Pro simulator: compact presentation, expanded presentation, the stale
state, and tap-to-open all **pass**. Tap-to-open reaches the app overview, which is what this design
routes to.

## Unit 3 — Mute and stop intents · implemented, simulator verified

Part of requested parity, not deferred out of it. Android drives mute and stop through notification
actions; iOS needs the App Intent equivalent, and iOS already declares
`onNotificationActionRequested` with no sender.

**Shared TypeScript, implemented on this branch.** Mac's approved `LiveActivityIntent` and router
emit the existing `mute` action with an **optional** `desiredMuted` boolean:

- `addVoiceNotificationActionListener` passes `desiredMuted` through as a second argument, and
  normalises anything that is not a boolean to absent, so a malformed native payload cannot mute a
  call silently.
- `applyRealtimeMuted(desired?)` applies an explicit state as requested instead of toggling, so a
  repeated mute request leaves the session muted. Omitting it keeps the legacy toggle, which is what
  the Android action and the in-app button still send.
- With no live session the mute action is a no-op. A stale control must never open the microphone,
  and must never leave a mute flag armed for the next call.
- A start deferred behind VAD arming has no transport yet. `startRealtimeAfterService` applies the
  recorded state to the handle before it goes live, so a mute requested during that window cannot
  leave the JS flag and the Live Activity claiming muted while the microphone opens unmuted.
- Every call carries a generation token. `setVoiceGeneration` is an optional native method taking a
  string and returning nothing: a fresh `randomUUID()` at the start of a call, and `""` at teardown
  so native can tell a real teardown from a replacement and settle a pending stop before cancelling
  anything else. A module without the method is a silent no-op, so Android is untouched.
- The action event carries an optional `generation`, and the handler rejects any supplied generation
  that is empty or does not match the running call before acting. A queued event from an ended call
  can never reach the next one. Legacy Android events omit the field and keep their behaviour; a
  field present but not a string is coerced to empty and rejected rather than read as legacy.
- The token rotates synchronously at start and teardown, so a stop and start that React coalesces
  into one render still rotate it. This is why rotation does not depend on a `disconnected` snapshot
  reaching `updateNotification`, which the effect's own cancellation can drop.
- `stop` keeps its existing idempotent teardown path.
- The `start` branch is now an explicit `action === 'start'` test rather than a default `else`, so an
  action this build does not recognise cannot fall through and open a session.

**Native side, integrated.** `actionsAvailable` gates the controls on a JS listener having been
observed *and* voice being active, so stale or unavailable controls are hidden rather than shown
dead. Per the Mac and root agreed contract it **excludes `connecting`**; the shared deferred-start
mute fix does not broaden that gate and no broadening is requested. The intent awaits the reflected `updateNotification` state under a bounded timeout and reports
no local success it has not seen confirmed.

Verified on the simulator, with synthetic background actions:

- Mute, unmute and stop from the background — **pass**, on the earlier build and again on the
  corrected one.
- Mute, stop and token teardown on the corrected build — **pass**.
- Controls hidden while connecting and whenever no token is held — **pass**.
- Listener off — **pass**.
- An acknowledgement withheld produces no fake mute — **pass**.
- Authorization off, and authorization explicitly corrected to on within the same call, both give
  fresh state — **pass**.

## Units 4 and 5 — Terminal parity and signing guards · implemented, one case environment-blocked

Integrated, so these are no longer a separate branch:

- Terminal `show` and `hide`.
- `autoShowKeyboard`.
- The shared gates covering both.
- Extension signing guards.
- Export guards.

Verified on Mac binary `74891c84` from source `4f5b015`, which matches the integration's mobile
paths independently:

- Hardware input, a custom Enter, Tab and Ctrl-C, with `autoShowKeyboard = false` — **pass**.
- The preview regression: Zoom, Fit and Close, three times, same PID — **pass**.

One case is still open. The `autoShowKeyboard = true` software-keyboard case is **blocked
simulator-wide by the environment**, not by a known product defect: LLDB showed the terminal as
first responder with the keyboard neither visible nor suppressed, and the touch path was corrected
to show the keyboard and reload even when the view is already focused. It cannot be exercised until
the environment allows it, so no pass is claimed for it.

Signing and export guards still have no archive or export behind them, so native acceptance for
unit 5 remains open.

## Unit 6 — Kitty graphics · RGBA f32 accepted on the current host

The Kitty renderer **is compiled into the existing iOS GhosttyKit**. It is not a missing renderer and
must not be recorded as one.

Direct native raw image writes pass: a red rectangle, a blue one, replacement and delete. The
renderer works when it is handed pixels.

End to end now passes for **RGBA `f32`**, red and blue, host to iOS.

**Not every Kitty format is supported.** `f24` and `f100` are an existing shared host format gap.
It is host-side, not a native defect, and closing it is out of scope here: iOS parity adds no new
codec and no new dependency for it. The f32 pass must not be read as covering every format.

Practical requirements for Kitty on iOS, as shipped:

- Kitty graphics enabled in Herdr.
- RGBA `f32`.

Root reviewed the format and mutation report: four independent mutants fail, and the restored tree
passes 4 of 4 along with the host typecheck and the architecture check.

Mac's pixel acceptance against the corrected host at `09c1f405`, SHA `46e010cb`, **passes**:

- Red draws.
- Blue replaces it.
- Backgrounding the app and foregrounding it from the icon retains the left placement.
- Leaving the terminal and reopening it retains the left placement.
- An explicit producer delete removes the blue.
- No resurrection: after a delete, leaving the terminal and reopening it comes back empty.

Render, replace, replay and delete for RGBA all pass at runtime on the current host.

## Files

- `apps/mobile/sources/settings/presentation/SettingsView.tsx` — Unit 1, this branch.
- `apps/mobile/modules/voice-overlay/index.ts` — Unit 3 shared bridge, this branch.
- `apps/mobile/sources/conversation/application/realtimeSessionState.ts` — Unit 3 shared action
  handling, this branch.
- `apps/mobile/sources/utils/dictation.spec.ts` — the existing voice flow test, extended in place.
- `apps/mobile/modules/voice-overlay/ios/VoiceOverlayModule.swift` — Unit 2, Mac.
- `HerdLiveActivity` target, attributes, widget, config plugin, `app.config.js` — Mac.
- Terminal sources and signing configuration — Units 4 and 5, opus-verification, separate branch.
- `KernelNotifications.tsx` — unchanged, and should stay unchanged unless evidence requires it.

## Correction carried from the original inventory

The first inventory claimed iOS receives no local session notifications. **That was wrong. Local
lifecycle notifications already exist on iOS.** `catalog/application/sync.ts`
`presentPendingLifecycleEvents` (`:425-460`) schedules on every non-web platform including iOS, and
Android's `scheduleSessionNotification` returns early as well. The iOS skip at `:414` is in
`applyAttentionCatalog`, a fallback used only when the lifecycle catalog is unavailable. No
notification-delivery change should be made on the strength of the withdrawn claim.

## Status

**Implementation is complete. This is not fully tested, and must not be recorded as such.**

**Verified at runtime.** The Settings row, the Live Activity and its controls, the terminal cases
listed under units 4 and 5, and Kitty on the current host. Simulator results are on an iPhone 16 Pro
simulator; Kitty is on the current host.

**Pending verification.** The `autoShowKeyboard = true` software keyboard, blocked simulator-wide by
the environment. Exported extension signing, with no archive run against it. Android's Settings row
and the foreground resume. Everything device-bound, including audio and APNs delivery.

**Unsupported, out of scope.** Push-started and push-updated Live Activities over APNs, and the
`f24`/`f100` host format gap.

Mac's exact hashes and evidence are retained in the watched `ios-parity-acceptance-current.md`.

## Verification

Each result is labelled with what actually ran. Simulator results are runtime passes on a simulator
and nothing more; no result below comes from a physical device.

Current exact source is `09c1f405`, built as
`46e010cb5140d32ad2b9e0b2553eb9f668fb60bd07ad438d606438deeb09bd93`. Its CI passes in full: the suite
in 5m54s as run `34075579875`, plus CodeQL. The host real flow passes 4 of 4, and the restored tree
passes the host typecheck and the architecture check with four independent mutants failing as they
should.

Passed, compile only:

- [x] `tsc --noEmit` clean for `apps/mobile`.
- [x] Widget target compiles.
- [x] Controller standalone typecheck.

Passed, behavioural:

- [x] The voice flow test covers duplicate explicit mute settling on muted, explicit unmute, the
      legacy Android toggle, a stale action after teardown changing nothing, repeated stop, an
      unrecognised action not starting a session, and a mute requested while VAD arming still gates
      the start reaching the transport that opens afterwards. Each assertion was confirmed to fail
      when its behaviour is reverted.

Passed, iPhone 16 Pro simulator:

- [x] Live Activity compact and expanded presentation, the stale state, and tap-to-open.
- [x] Mute, unmute and stop from the background, on the earlier and the corrected build.
- [x] Mute, stop and token teardown on the corrected build.
- [x] Controls hidden while connecting and with no token held; listener off; a withheld
      acknowledgement producing no fake mute.
- [x] Authorization off, and authorization corrected to on within the same call, both fresh.
- [x] The Settings row visible and on, with the Lock Screen and Dynamic Island subtitle present in
      the full accessibility label.
- [x] Terminal with `autoShowKeyboard = false`: hardware input, a custom Enter, Tab and Ctrl-C.
- [x] The preview regression: Zoom, Fit and Close, three times, same PID.
- [x] Direct native raw image writes: a red rectangle, a blue one, replacement and delete.
- [x] Kitty end to end for RGBA `f32`, red and blue, host to iOS.
- [x] Kitty pixel acceptance on the corrected host: red draw, blue replacement, placement retained
      across app background and icon foreground, placement retained across leaving and reopening the
      terminal, an explicit producer delete removing the blue, and no resurrection after that delete
      when the terminal is closed and reopened.
- [x] RGBA render, replace, replay and delete at runtime on the current host.

Pending verification:

- [ ] `autoShowKeyboard = true` with the software keyboard, blocked simulator-wide by the
      environment rather than by a known defect.
- [ ] Signing and export of the extension through a real archive.
- [ ] Android: the Live agent updates row and its copy are unchanged, on a build where the capability
      is present and again where it is absent.
- [ ] iOS: the enabled state refreshes when returning from Settings to the foreground.
- [ ] iOS: a Live Activity starts, updates and ends against real agent lifecycle transitions on a
      device.
- [ ] iOS: mute and stop intents act reliably on a device across every state above.
- [ ] iOS realtime voice on physical hardware.
- [ ] The bridge's `desiredMuted` and `generation` normalisation, which every consumer test mocks
      away and which is therefore exercised only through the native path.

Unsupported, out of scope:

- Push-started and push-updated Live Activities over APNs. Not implemented and not planned here.
- `f24` and `f100`, an existing shared host format gap. iOS parity adds no codec or dependency for
  it, and no Kitty format beyond RGBA `f32` is claimed supported.

## Scope limits

Pending verification and unsupported are different things, and are kept apart below. Neither may be
reported as a runtime pass.

Pending verification:

- **Physical-device behaviour.** No physical iPhone has been available, so audio has never run on
  hardware and APNs delivery has never been observed. Every iOS result on this page is from an
  iPhone 16 Pro simulator; the Kitty results are from the current host.
- **Exported extension signing.** No archive or export has been run against it.
- **The `autoShowKeyboard = true` software keyboard.** Blocked simulator-wide by the environment
  rather than by a known defect.

Unsupported, out of scope:

- **Push-started and push-updated Live Activities over APNs.** This workstream updates the activity
  from the app while it runs. Push activities are not implemented and are not claimed.
- **Kitty formats beyond RGBA `f32`.** `f24` and `f100` are an existing shared host format gap,
  host-side rather than native. No codec or dependency is added for them here. Kitty on iOS requires
  Kitty graphics enabled in Herdr and RGBA `f32`.

Known behaviour, by design:

- **The Settings row opens Settings, and grants nothing.** It uses the public
  `openSettingsURLString`, which in the simulator lands on Apple Settings' Apps list rather than
  muxr's own page, and the tap grants no permission by itself.
- **Tap-to-open reaches the app overview, not a chosen session.** No session route exists in the
  notification payload, so per-session routing is neither implemented nor claimed.
- **OS background limits apply.** Live Activities have system-controlled lifetimes and update
  budgets, and an app that is not running cannot update one locally. The surface is best-effort and
  cannot be the only signal that an agent needs attention.
