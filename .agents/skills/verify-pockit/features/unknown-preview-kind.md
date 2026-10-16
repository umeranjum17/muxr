# Keep the mirror view up for a preview kind the client does not know

A host newer than the client can name a device kind this build has never heard
of. The mirror view must stay up rather than index a gesture, key or copy table
that lacks that kind: the header and stage render, the help popup shows the
general desktop gestures, and the preview toolbar shows no device keys. A kind
this build does know is unchanged.

## Sub-features

- `preview-unknown-view` an unknown kind renders the preview surface, its
  generic name (`Device preview`) and title, with no crash — the header, the
  status/failure overlay and the toolbar all stay up.
- `preview-unknown-gestures` the help popup lists the general desktop gestures
  (`Double-tap`, `Two fingers`, `Drag on the whole desktop`), never a device's.
- `preview-unknown-keys` the toolbar renders no `PREVIEW_KEYS` entries: no
  Android `Back`/`Home`/`Recents`, no iOS `Home`.
- `preview-known-unchanged` an `android` or `ios` kind keeps its own gesture
  list, device keys and copy.

## How to get to it (user POV)

Pair a phone or an installed PWA to a computer, open a pane whose agent shows a
device preview, and Watch it. The header, gestures and toolbar are the same as
for a known emulator or simulator. A newer host's unknown device reads as
`Device preview` and behaves the same, without the view falling over.

## Driving it with the private stack

Preconditions: the host is the only producer of a pane's preview, and it
announces only `android` and `ios`; `catalog/infrastructure/sessionMapping.ts`
and the stored `MetadataSchema` also drop a kind this build does not know before
the view sees it. So a live capture cannot be driven by a real host. Feed the
unknown kind with a throwaway local injection: in a task copy only (never
committed), set `preview` in `sessionInfoToSession` to a fixed unknown kind, for
example `{ kind: 'web' as unknown as 'android', title: 'Chromium', since: 1 }`,
then build the web export with the lab flag.

1. `EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export` (see
   ./lab-browser-pairing.md) and confirm the build carries both the hook and
   the fallback copy (`grep -l __MUXR_LAB_PAIR__ apps/mobile/dist/_expo/static/js/web/*.js`).
2. Start the loopback fake stack from ./browserPairLab.mjs, mint a browser link,
   and serve the export with `scripts/diagnostics/application/serveWebExport.mjs`
   on a free port (never 8792).
3. Open the installed-PWA window with chrome-devtools-axi, pair through
   `window.__MUXR_LAB_PAIR__(<browser link>)`, open a session, and Watch the
   preview; navigate to the pane's `?desktop=preview` route if the chip does not
   open it.
4. Capture the toolbar (no device keys) and the help popup (general gestures) at
   393 and 270 px. Pass: the view stays up, the help lists the general desktop
   gestures, and no `Back`/`Home`/`Recents` key renders.
5. Revert the injection so the task copy carries only the guarded view change.

## Gotchas

- The build's `previewIcon` gives an unknown kind a plain device mark, and the
  generic copy lives in `desktopCopy.ts` (`unknownPreviewCopy`); do not add a
  new real kind to prove the fallback.
- The toolbar's keyboard disc and its separator are not `PREVIEW_KEYS` entries;
  the fallback hides only the device keys, as the requirement says.
- The Chrome devtools tool kills any process still bound to its shell on a
  timeout: launch the lab and static server detached (`setsid`), and stop only
  the exact PIDs and the named chrome-devtools-axi session this run started.
