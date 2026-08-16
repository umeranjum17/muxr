# Demo recording script (≤ 30 seconds)

One screen recording is the highest-leverage launch asset. This script produces a split view:
**phone on the left, laptop terminal on the right**, showing a real muxr session driving Pi on the laptop.

Target length: **25–30 seconds**. Record at 1080p; export as GIF (Reddit) and MP4 (GitHub README).

## Before you record

1. Clean terminal theme (dark background, readable font — 14px+).
2. Phone: disable notifications, full brightness, dark or light mode (pick one, keep it through the clip).
3. Laptop terminal shows **only** what you intend to reveal — no API keys, private paths, or unrelated tabs.
4. Stack running locally (`yarn up` from the repo root, then the web/app
   server with the connection values it prints):
   ```bash
   yarn install --frozen-lockfile && yarn build
   yarn up
   ```
5. Pre-create the app account on the phone and confirm the session list loads.
6. Pick a tiny, safe task for Pi (e.g. "create hello.txt with one line" in a throwaway directory).

## Layout

```
┌─────────────────────┬──────────────────────────────┐
│                     │  $ node apps/host/dist/...   │
│   Phone (9:16       │  relay link: open            │
│   or 9:19 crop)     │  [Pi session output scrolls  │
│                     │   here as agent works]       │
└─────────────────────┴──────────────────────────────┘
     ~45% width              ~55% width
```

Leave a 2-second lead-in before the first action so viewers orient.

## Shot list

| Time | Phone | Laptop terminal | VO / caption (optional) |
|---|---|---|---|
| 0:00–0:03 | Welcome or session list (already logged in) | Host already connected (`relay link: open`) | "muxr — Pi on your machine, phone as the remote." |
| 0:03–0:06 | Tap into an existing session **or** tap New → enter the throwaway cwd | Host log quiet | "Sessions live on the host; the phone is a client." |
| 0:06–0:12 | Type a short prompt (≤ 8 words). Send. | Pi begins working — tool call or file write visible | "Send a prompt from the phone." |
| 0:12–0:20 | Agent response streams in (tool card or text) | Matching stdout / file operation in terminal | "Agent runs on the laptop under your user." |
| 0:20–0:25 | Scroll slightly to show structured tool output (diff or file read) | Show resulting file if quick (`cat hello.txt`) | "Tool results render in the app, not just raw scrollback." |
| 0:25–0:30 | Back out to session list; optional unread badge | Hold on terminal | "Self-hosted relay. Your machines." |

**Hard stop at 0:30.** A shorter 20-second cut is fine; do not pad.

## What to show (priority order)

1. Prompt sent from phone → visible effect on laptop (the causal link).
2. Structured agent output on the phone (tool card beats plain text).
3. Session list with at least two sessions or a machine name (proves it is not a mock).

## What to avoid

- Login / "Create account" flow — burns 5+ seconds and adds no signal.
- Settings screens, connection URL editing, or E2EE key entry — save for docs.
- Errors, reconnect spinners, or "disconnected" states.
- Long prompts, large diffs, or tasks that take > 10 seconds to finish.
- No inherited branding or stale icons — if an old asset flashes, fix assets first.
- Voice, custom server, or any removed feature.
- Real project paths, customer names, or secrets in the terminal.
- Simulator keyboard hunt-and-peck — type the prompt before rolling, or use a pre-filled draft.

## Export

| Destination | Format | Notes |
|---|---|---|
| GitHub README | MP4 or GIF ≤ 10 MB | Place at `docs/demo.mp4` or attach to release |
| Reddit (r/LocalLLaMA) | GIF preferred | ≤ 30 s, ≤ 50 MB; phone+terminal split reads at thumbnail size |
| Issue / PR | Same GIF | Link to full MP4 in release assets if needed |

## One-line caption (Reddit title helper)

> Drive coding agents on your own machine from your phone — live terminals, approvals, diffs, and artifacts over a self-hosted relay.
