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

This spec tracks the whole workstream. Only Unit 1 is edited from this branch.

## Workstream and ownership

| unit | owner | branch | status |
|---|---|---|---|
| 1. Settings live-updates capability gate | frontend | `feat/ios-feature-parity` | implemented, untested |
| 2. Native Live Activity `HerdLiveActivity` | Mac | Mac native branch | in progress |
| 3. Mute and stop intents | Mac | Mac native branch | staged next, after lifecycle compiles |
| 4. Terminal show, hide and `autoShowKeyboard` with shared gates | opus-verification | `feat/ios-terminal-parity` | in progress |
| 5. Extension signing and export guards | opus-verification | `feat/ios-terminal-parity` | in progress |
| 6. Kitty graphics runtime | Mac | — | unverified, under diagnosis |

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

## Unit 2 — Native Live Activity · in progress, Mac

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
already passes the complete content model, so nothing requires shared storage. Tap routing uses
`widgetURL` with the existing `muxr` scheme and the already-entitled `applinks:trymuxr.com`.

Evidence so far, all compile-level:

- Widget target compiles — **pass**.
- Controller standalone typecheck — **pass**.
- Full app build — **pending**.

## Unit 3 — Mute and stop intents · staged next, Mac

Part of requested parity, not deferred out of it. Android drives mute and stop through notification
actions; iOS needs the App Intent equivalent, and iOS already declares
`onNotificationActionRequested` with no sender. Sequenced immediately after the lifecycle path
compiles so the intents are built against a working activity rather than alongside one.

**Pending reliable implementation and validation.** Compiling is not the bar; the intents must act
correctly across the stale, disabled, idle and logged-out states below.

## Units 4 and 5 — Terminal parity and signing guards · in progress, opus-verification

On `feat/ios-terminal-parity`, out of scope for this branch, recorded here so the board shows one
workstream:

- Terminal `show` and `hide`.
- `autoShowKeyboard`.
- The shared gates covering both.
- Extension signing guards.
- Export guards.

## Unit 6 — Kitty graphics · unverified, under diagnosis

The Kitty renderer **is compiled into the existing iOS GhosttyKit**. It is not a missing renderer and
must not be recorded as one.

The first actual baseline on device produced **marker output and no image**. Mac is investigating the
transport and raw RGB path. Until that diagnosis lands, the correct label is **unverified and under
diagnosis**. No config patch is applied on the strength of a guess, and real image, replace, delete,
scroll, resize and reconnect behaviour is verified before any config change is considered.

## Files

- `apps/mobile/sources/settings/presentation/SettingsView.tsx` — Unit 1, this branch.
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

Compile-level checks have passed and are marked as such. Nothing below is a runtime pass.

Passed, compile only:

- [x] `tsc --noEmit` clean for `apps/mobile` after the Unit 1 change.
- [x] Widget target compiles (Unit 2, Mac).
- [x] Controller standalone typecheck (Unit 2, Mac).

Open:

- [ ] Full app build with the widget target included.
- [ ] Android: the Live agent updates row and its copy are unchanged, on a build where the capability
      is present and again where it is absent.
- [ ] iOS: the row appears once the native capability reports true, shows the Lock Screen and Dynamic
      Island copy, and its action opens iOS settings.
- [ ] iOS: the enabled state refreshes when returning from Settings to the foreground.
- [ ] iOS: a Live Activity starts, updates and ends against real agent lifecycle transitions.
- [ ] iOS: tapping the activity opens the right session from cold start and from background.
- [ ] iOS: truthful states — stale, disabled, idle and logged out each show the honest surface rather
      than a stuck activity.
- [ ] iOS: mute and stop intents act reliably across every state above.
- [ ] iOS: terminal show, hide and `autoShowKeyboard` behave through the shared gates.
- [ ] iOS: signing and export guards hold for the extension.
- [ ] iOS: Kitty image, replace, delete, scroll, resize and reconnect verified on device.
- [ ] iOS realtime voice validated on physical hardware.

## Scope limits, explicitly unverified or unsupported

None of these may be reported as a runtime pass.

- **Physical-device voice is unverified.** Audio functions exist in source, but a simulator run
  aborted in CoreAudio before voice could be exercised and no physical iPhone has been available.
  Voice remains unverified until it runs on hardware.
- **Remote APNs-driven Live Activity updates are unsupported and out of scope.** This workstream
  updates the activity from the app while it runs. Push-started and push-updated activities are not
  implemented and are not claimed.
- **OS background limits apply.** Live Activities have system-controlled lifetimes and update
  budgets, and an app that is not running cannot update one locally. The surface is best-effort and
  cannot be the only signal that an agent needs attention.
- **Kitty graphics behaviour is unverified and under diagnosis**, not a missing renderer and not a
  pass.
