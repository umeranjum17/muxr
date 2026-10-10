# Name agents on Home by kind and task, never a launch id

Home's `Ready · unseen` rows lead with what the agent is working on, else its
kind; they never show Herdr's internal `pp_*` launch id. The shared namer
`agentLabels` (`apps/mobile/sources/herd/domain/agentPresentation.ts`) rejects
the id through the contract's `parseAgentName` and drops it from a pane label or
window title, so an agent that has not published a real name yet reads as its
kind (`Codex`, `Pi`), the same way every other surface names it.

## Sub-features

- `no-internal-id` a Codex and a pi agent with no title yet read as `Codex` and
  `Pi`, never `pp_<hex>`/`pph_<hex>`.
- `who-line` the line under the task (or the row title when it is the name)
  carries the kind and any real name, never the id.
- `id-in-title` a pane label or window title that only carries the id says
  nothing and is ignored, so it cannot become the row's task either.

## How to get to it (user POV)

Pair a computer that has a Codex and a pi agent, each with a finished turn the
phone has not seen, and open Home. The `Ready · unseen` rows show the agent's
kind and task; no row shows a `pp_*` id.

## Driving it with the private stack

Preconditions: the lab PWA of `lab-browser-pairing.md` (export built with
`EXPO_PUBLIC_MUXR_LAB_PAIR=1`, served by `serveWebExport.mjs`), and a real-Herdr
lab under a private `MUXR_HOME` that launches one Codex and one pi agent in a
non-default session.

- Start the lab and let each agent finish a turn so Home holds unseen output for
  both. The host's `lifecycle-activity.json` carries each agent's `agentName`
  (the raw `pp_<hex>` id until a real name exists).
- Serve the lab-flag export, open the installed-PWA window at 393 px, and pair it
  with `window.__MUXR_LAB_PAIR__(<browser link>)`; reload.
- Assert the row text: `document.body.innerText` under `Ready · unseen` reads the
  kind/task (e.g. `opencode · OpenCode`, `Pi`) and matches no
  `/pph?_[0-9a-f]+/`.
- Capture Home at 393 px light and dark.

## Gotchas

- The id arrives as `agentName` on a lifecycle event before a real name exists;
  `parseAgentName` is the single boundary that rejects it. Do not add a second
  filter in another surface.
- `agentTask` treats the first meaningful source as the task, so pass an
  already-sanitized label/terminalTitle/taskTitle or an id becomes the task.
- Never assert on a Herdr internal id anywhere; a row must name the agent the way
  the rest of the app does.
