---
name: "muxr-attachments"
description: "HARD RULE for agents running in a herdr pane: every user-facing artifact (screenshot, snapshot, generated image, recording, export) must be written to the pane's muxr attachments dir so it appears on the user's phone. Use whenever a task produces a file the user should see."
version: 2
created: "2026-08-06"
updated: "2026-08-06"
---
## When to Use
Use whenever a task produces a FINAL user-facing artifact file — screenshots from agent-browser or Playwright, generated images, exports, recordings — and the agent is running inside a herdr pane (HERDR_PANE_ID set). Not for intermediate scratch files.

## Procedure
1. Compute the dir: `ATTACH="$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"` (the pane id contains a colon — quote the path).
2. `mkdir -p "$ATTACH"`.
3. Save the artifact DIRECTLY there when the tool accepts an output path; otherwise save then `cp <file> "$ATTACH"/` in the same step.
4. Do this every time, without being asked — the host watches the dir and the phone shows the file in ~1s. A file left anywhere else is invisible to the user; there is no other channel.

## Pitfalls
- If HERDR_PANE_ID is unset the agent is not in a herdr pane — skip silently; no phone is watching.
- Do not dump intermediates, logs, or junk — the dir is a user-facing surface with a 50-file cap.
- Images over 1 MiB appear as a named row only (no inline preview) — downscale big screenshots (e.g. 1280px wide) before writing if the preview matters.
- "Final artifact" is not a judgment call that defaults to no: when in doubt whether the user would want to see it, write it.

## Verification
1. `ls "$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"` shows the file.
2. The phone app's session for this pane shows the attachments pill with the new item.
