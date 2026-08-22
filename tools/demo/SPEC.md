# muxr demo film — spec

36 seconds. One job, start to finish. The thesis is one sentence: **the desk and
the phone are two windows onto the same pane.** Every shot proves that or sets
it up.

Timing lives in `lib/film.mjs`, which self-validates. This table mirrors it.

## Shot table — 30fps, every length a multiple of 6 frames

| # | Name | Frames | Time | Source | What's on screen |
|---|------|--------|------|--------|------------------|
| 01 | Full-screen terminal | 0–90 (90) | 0.0–3.0 | desk | `/var/tmp/muxr-demo`, the task prompt, Claude reads `token-store.ts` and `session.test.ts`, finds the race, starts editing. No chrome. |
| 02 | Macro, pending interaction | 90–180 (90) | 3.0–6.0 | desk | `Claude wants to run pnpm test` and its options, ~3×, bleeding off frame. Word boundaries only. Exports as the README loop's third second. |
| 03 | Abandoned | 180–270 (90) | 6.0–9.0 | desk | Pull back 100% → 20%. `WAITING FOR INPUT · 00:41`. No copy. |
| 04 | Match cut desktop → phone | 270–390 (120) | 9.0–13.0 | phone | Same prompt, same size, same position as 02. Phone revealed by status bar, header `auth-fix · Claude Code`, key row. |
| 05 | HERO | 390–510 (120) | 13.0–17.0 | desk + phone | Both edge to edge. `↵` on the phone; within 8 frames the desk shows `Running tests…`. Both reach `PASS tests/auth/session.test.ts`. |
| 06 | Desk recedes | 510–582 (72) | 17.0–19.4 | composite | Desk scales down and blurs, phone rises to centre. Transition only. |
| 07 | Work progresses | 582–702 (120) | 19.4–23.4 | phone | Three states, hard cut, header never moves. |
| 08 | Completion | 702–810 (108) | 23.4–27.0 | phone | Notification, then the finished state large. Hold 1s before the cut. |
| 09 | Review the diff | 810–900 (90) | 27.0–30.0 | phone, light | muxr Changes. The one added line in `token-store.ts`. |
| 10 | Herd reveal | 900–990 (90) | 30.0–33.0 | phone | `4 sessions · 1 machine`, space `muxr-demo · 4 agents`. |
| 11 | Brand close | 990–1080 (90) | 33.0–36.0 | render | Wordmark, the line typed with a cursor, `trymuxr.com`. |

### Amendments to the original brief

1. **The 6-frame rule wins.** 06 was 75f → **72f**; 08 was 105f → **108f**.
   This pulls 07 and 08 three frames earlier. Shots 09, 10 and 11 keep their
   original boundaries and the total stays 1080. This is the only arrangement
   where every shot is a multiple of six and the film is exactly 36 seconds.
2. **Shot 10 reads `4 sessions · 1 machine`.** One machine is paired. The
   storyboard said two; the take is right.
3. **The repo lives at `/var/tmp/muxr-demo`, not `~/code/muxr-demo`.** Every
   muxr surface prints an agent's working directory, so `~/code/muxr-demo`
   renders as `/home/<user>/code/muxr-demo` on the Herd screen, the session
   header and the Claude Code banner — a §3.3 leak in shots 04, 08 and 10. The
   path is not maskable without doctoring frames, so the shoot moved the repo
   somewhere without a username in it.
4. **Shot 05 does not reach `PASS tests/auth/session.test.ts`.** Claude Code
   collapses shell output to `Ran 1 shell command` and never prints the test
   summary to the screen, so no frame of the take contains that line. The desk
   reacts to the tap within one frame and both screens show the command
   running; the result itself lands in shot 08, in Claude's own words —
   `pnpm test: 25 passed` — which is the same fact from the same run.
5. **Shot 03's wait was directed, not invented.** The storyboard says `00:41`,
   and the counter reads `00:41` through `00:44` — because the take left the
   prompt deliberately unanswered for 45 seconds before the phone answered.
   Directing the pause is staging, the same staging as walking away from the
   desk; the counter itself counts the take's real wall clock. Forty-five
   seconds and not longer, because the number is read two ways at once: how
   long the desk failed, and how fast the phone caught it.
6. **Shot 08 has no notification.** muxr posts a single ongoing notification
   for the session you are connected to, not a per-agent completion, so there
   was no `auth-fix is done` notification to film. The shot is the finished
   state alone.
7. **Shot 07's third state comes from the after pass.** The first two are the
   take itself — the tests running, the agent's second question. The third,
   the written-up root cause, comes from the phone pass recorded after the job
   finished, framed identically; inside the take that screen only exists
   below the fold.
8. **The film breathes.** After the owner asked for Apple pacing, every held
   shot gained a slow linear push-in (2-4%), the end card settles instead of
   popping, and the film's one soft edit was added: shot 10 dissolves into
   the end card over 12 frames. Every other cut stays hard — that is the
   film's language — and the film stays silent: both shipping surfaces
   autoplay muted, and a synthesized bed would be the one element that is
   neither real nor excellent. The README loop is frames 390-702
   (shots 05-07): it opens on the thesis image — desk and phone side by
   side, the tap, the desk reacting — because the loop is most visitors'
   entire impression and the product has to be legible in frame one. The
   loop alone carries a quiet corner wordmark; these frames travel without
   the README around them, and the film itself stays unmarked.
9. **Shot 04 does not hold at 390px.** Its last second is the whole phone
   standing on ink, which at 390px is ninety-nine pixels across. That is the
   reveal the storyboard asks for and it is silhouette, not text; every other
   shot in the film is legible at 390px.

## The job

```
repo      muxr-demo            path     /var/tmp/muxr-demo
session   auth-fix             agent    Claude Code
task      Fix the refresh-token race condition and run the auth tests
files     src/auth/token-store.ts, tests/auth/session.test.ts
command   pnpm test
```

The fix Claude actually wrote, and the whole of shot 09:

```diff
     async rotate(refresh: string): Promise<string> {
         const subject = this.subjectOf(refresh);
         if (subject === undefined) throw new Error('refresh token is not valid');
-        const next = await this.issue(subject);
-        return next;
+        // Retire before the first await: the check and the retirement have to
+        // land in one tick, or a concurrent redemption passes the same check.
+        this.invalidate(refresh);
+        return this.issue(subject);
     }
```

23 tests before, 26 after — the three it added fail against the old code.

## The herd at 30s

herdr workspace `wYA`, label `muxr-demo`, four real panes on one machine.

| session | agent | state in shot 10 |
|---------|-------|------------------|
| `billing-refactor` | Codex | live (green) |
| `landing-copy` | Gemini CLI | idle |
| `flaky-e2e` | Cursor | idle |
| `auth-fix` | Claude Code | live (green) — the one the film followed |

## Hard rules

1. Same repo, same session, same files in every shot.
2. No speed-up. Cut to the moment, found by motion/NCC, not a fixed offset.
3. Geometry holds across cuts. 02→04 identical prompt size and position; 07's
   header pixel-identical across all three states. Measured, not eyeballed.
4. Ink ground, no device. No bezel, no 3D handset, no grain, no depth of field.
   The only colour in the film is inside the screens.
5. No captions. The only authored line is shot 11.
6. Legible at 390 CSS px. Scale the source, never shrink the type.
7. Bleeds clip at word boundaries. No cut letters.
8. No music. Every shot a multiple of 6 frames.
9. The diff is the diff.
10. `lib/film.mjs` is the only thing that decides timing. The README loop is
    shots 01–03 cut from this same timeline.
