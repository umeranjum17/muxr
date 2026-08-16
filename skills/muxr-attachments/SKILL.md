---
name: "muxr-attachments"
description: "Copy user-facing artifacts (screenshots, snapshots, exports, generated images) into the muxr per-pane attachments dir so they appear as a pill on the user's phone, keyed by HERDR_PANE_ID."
version: 1
created: "2026-08-05"
updated: "2026-08-05"
---
## When to Use
Use whenever a task produces a FINAL user-facing artifact file — screenshots from agent-browser or Playwright, generated images, exports, recordings, AND documents: markdown notes, emails, reports, code, JSON — anything the user should be able to read on their phone. Not for intermediate scratch files.

## Procedure
1. Compute the dir: `ATTACH="$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"` (HERDR_PANE_ID is injected into every herdr pane; the id contains a colon — quote the path).
2. `mkdir -p "$ATTACH"` and copy the FINAL artifact there: `cp shot.png "$ATTACH"/` — one command, then continue the task.
3. The host watches the dir, compresses raster images (max edge 1568px, webp q80 — a 7MB phone screenshot lands ~150KB), inlines text/docs whole (≤256KB) and videos (≤32MB) and PDFs (≤8MB), and the phone app shows them as an attachments pill on that pane's session within ~1s. Images open a swipeable carousel; text/docs (md, eml, code, json...) open a readable preview; videos play in the browser player; PDFs render page-by-page via pdf.js; empty files render as an explicit "Empty file" state. Every row and viewer has a download button — oversized files are fetched from the host on demand at download time.

## Pitfalls
- If HERDR_PANE_ID is unset the agent is not running in a herdr pane — skip silently; there is no phone to show the artifact to.
- Do not dump intermediate files, logs, or junk — the dir is a user-facing surface with a 50-file cap.
- No manual downscaling needed: the host compresses every png/jpg/webp automatically. Save at full resolution.
- Write documents DIRECTLY as .md/.txt/.eml/code files — they preview natively. Videos (mp4/webm/mov/mkv ≤32MB) and PDFs (≤8MB) preview too. Anything bigger appears as a named row only.
- The pane id contains a colon (w2A:p4) — always quote the path.

## Verification
1. `ls "$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"` shows the copied file.
2. The phone app's session for this pane shows the attachments pill with the new item.