---
title: iOS feature parity
slug: ios-feature-parity
status: in-progress
created: 2026-09-07
updated: 2026-09-07
owner: umer
links:
  - ~/.muxr/attachments/pane/w1FE:p1S/ios-parity-inventory.md
---

## Context

Android and iOS drifted in one specific area: the ongoing status surface. The audio half of the
voice overlay is implemented in source on both platforms, but every notification and service function
in the iOS native module returns a constant, so nothing on iOS shows that agents are working.

The platform-agnostic bridge for that surface already exists. `updateVoiceNotification`,
`clearVoiceNotification` and `addVoiceNotificationActionListener` in
`apps/mobile/modules/voice-overlay/index.ts` are the API both platforms are meant to implement, and
`KernelNotifications.tsx` already drives them. iOS declares the `onNotificationActionRequested` event
and never sends it. So this fills an existing seam rather than designing a new one.

This spec tracks the whole workstream. Mac's native commits are integrated, and this branch is the
same product tree as Mac's `ec39fd8` with the corrected Release binary `c23a1c98`.

## Workstream and ownership

| unit | owner | branch | status |
|---|---|---|---|
| 1. Settings live-updates capability gate | frontend | `feat/ios-feature-parity` | implemented, untested |
| 2. Native Live Activity `HerdLiveActivity` | Mac | integrated | implemented, simulator verified |
| 3. Mute and stop intents | frontend + Mac | integrated | implemented, simulator verified |
| 4. Terminal show, hide and `autoShowKeyboard` with shared gates | opus-verification | integrated | implemented, one case pending |
| 5. Extension signing and export guards | opus-verification | integrated | implemented, native acceptance pending |
| 6. Kitty graphics runtime | Mac | — | direct write verified, end to end unresolved |

All simulator results below were taken on an iPhone 16 Pro simulator. No physical device has been
used, so nothing here claims device audio, APNs, or remote Activity behaviour.

## Unit 1 — Settings capability gate · implemented, untested

`SettingsView.tsx` gated the Live agent updates row on `Platform.OS === 'android'`, so the row could
never appear on iOS even once the capability existed. The gate is now the native capability itself:

- `promotedNotificationsSupported = supportsPromotedNotifications()` — the native module decides,
  per OS build, whether a live status surface exists.
- Copy is chosen per platform by `liveUpdatesCopy`: iOS names the Lock Screen and Dynamic Island,
  Android keeps its existing status-bar island wording verbatim.
- The existing `AppState` resume listener already refreshed the enabled flag; with the platform gate
  removed it now refreshes on iOS too.
- The row's action stays `openPromotedNotificationSettings`, which iOS answers once Mac lands it.

Android behaviour is unchanged: `supportsPromotedNotifications()` there is the same real capability
check that previously sat behind the platform test, and the Android strings are untouched.

Evidence: `tsc --noEmit` clean for `apps/mobile`. Compile only. No runtime behaviour is claimed.

## Unit 2 — Native Live Activity · implemented, simulator verified

Target `HerdLiveActivity`, bundle identifier `com.trymuxr.app.activity`, **no App Group**. Root
verified the requirements against official ActivityKit documentation.

Fills the existing bridge rather than adding API:

- `updateNotification` → start or update the activity, from the seven scalars the bridge already
  passes (`mode`, `count`, `names`, `eventKey`, `voiceState`, `voiceName`, `muted`).
- `clearNotification` → end the activity.
- `supportsPromotedNotifications` → report real Live Activity availability, which is what makes the
  Settings row from Unit 1 appear.
- `canPostPromotedNotifications` → report the real authorization. It currently returns `true` on iOS
  while `supportsPromotedNotifications` returns `false`, so the module claims a permission it cannot
  honour; nothing user-visible depends on it today because Settings checks both.
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

## Units 4 and 5 — Terminal parity and signing guards · implemented, one case pending

Integrated, so these are no longer a separate branch:

- Terminal `show` and `hide`.
- `autoShowKeyboard`.
- The shared gates covering both.
- Extension signing guards.
- Export guards.

Simulator results:

- Normal `autoShowKeyboard = false`, with hardware and synthetic input and a custom Enter — **pass**.
- The explicit software keyboard — **pass**, after a Simulator UI fix.
- `autoShowKeyboard = true` on tap, and the preview regression — **pending**.

Signing and export guards still have no archive or export behind them, so native acceptance for
unit 5 remains open.

## Unit 6 — Kitty graphics · direct write verified, end to end unresolved

The Kitty renderer **is compiled into the existing iOS GhosttyKit**. It is not a missing renderer and
must not be recorded as one.

A direct native raw image write draws a red rectangle — **pass**. So the renderer works when it is
handed pixels.

The host to iOS Kitty path is still **unresolved**. On Linux, one client and two clients both send
inline APC, so client count alone is ruled out as the cause. Diagnosis continues, and no config
patch is applied on the strength of a guess.

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

## Verification

Each result is labelled with what actually ran. Simulator results are runtime passes on a simulator
and nothing more; no result below comes from a physical device.

CI at `c535c968`: the 32-check suite and CodeQL all pass, including the 95 mobile tests.

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
- [x] Terminal with `autoShowKeyboard = false`: hardware and synthetic input, and a custom Enter.
- [x] The explicit software keyboard, after a Simulator UI fix.
- [x] A direct native raw image write drawing a red rectangle.

Open:

- [ ] `autoShowKeyboard = true` on tap, and the preview regression.
- [ ] The host to iOS Kitty path end to end.
- [ ] Signing and export guards through a real archive and export.
- [ ] Android: the Live agent updates row and its copy are unchanged, on a build where the capability
      is present and again where it is absent.
- [ ] iOS: the Settings row appears once the native capability reports true, shows the Lock Screen
      and Dynamic Island copy, and its action opens iOS settings.
- [ ] iOS: the enabled state refreshes when returning from Settings to the foreground.
- [ ] iOS: a Live Activity starts, updates and ends against real agent lifecycle transitions on a
      device.
- [ ] iOS: mute and stop intents act reliably on a device across every state above.
- [ ] The bridge's `desiredMuted` and `generation` normalisation, which every consumer test mocks
      away and which is therefore exercised only through the native path.
- [ ] iOS realtime voice validated on physical hardware.

## Scope limits, explicitly unverified or unsupported

None of these may be reported as a runtime pass.

- **Physical-device voice is unverified.** No physical iPhone has been available, so audio has never
  run on hardware.
- **Remote APNs-driven Live Activity updates are unsupported and out of scope.** This workstream
  updates the activity from the app while it runs. Push-started and push-updated activities are not
  implemented and are not claimed.
- **OS background limits apply.** Live Activities have system-controlled lifetimes and update
  budgets, and an app that is not running cannot update one locally. The surface is best-effort and
  cannot be the only signal that an agent needs attention.
- **Every result above is from a simulator.** No physical device has been used, so device audio,
  APNs delivery and remote Activity updates are not claimed at all.
- **The host to iOS Kitty path is unresolved**, not a missing renderer and not a pass. The direct
  native write passing shows the renderer itself works.
- **Tap-to-open reaches the app overview, not a chosen session.** No session route exists in the
  notification payload, so per-session routing is neither implemented nor claimed.
