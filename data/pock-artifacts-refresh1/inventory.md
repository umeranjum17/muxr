# Artifact refresh inventory

Compared the README and public muxr-cloud site against pockit commit `323e4df46d02939d304cb00b9571c3c9eb1111f4` and changes since the README's prior feature refresh at `445db330a`. `muxr-cloud/marketing.lock.json` remains untouched at `fa0b780c`.

## README

- **Every agent, every machine:** copy already described pin/unpin; replaced the old Home image with a native capture showing `storefront` pinned above `npm test`.
- **Know your limits:** added a feature subsection and native Usage screenshot. Home and Usage share one reading; the screenshot shows remaining session/week amounts, reset and projected run-out times, plus red/amber pace treatment. A retained-reading timestamp appears in the Home capture.
- **Dictate the prompt:** updated the image to a native New Agent composer with a neutral draft and live dictation state. Copy explains Cancel and five-second Undo.
- Kept the launch film, tabs, panes, and remote desktop positioning unchanged. Remote desktop remains one feature among several.

Captured Android screens are 1080×2400 and committed as matching 540×1200 JPG/WebP pairs under `docs/assets/readme/`:

| Pair | Native screen | Evidence note |
| --- | --- | --- |
| `herd.jpg` / `herd.webp` | Home: fixture reading, 50% memory / 40% disk / 0.4 load / 1h uptime, `storefront` pinned above `npm test` | `.cache/task/captures/herd.png.note` |
| `usage.jpg` / `usage.webp` | Usage: neutral “Example” plan, 26% session and 62% weekly remaining, run-out estimates, no measured activity | `.cache/task/captures/usage.png.note` |
| `dictation.jpg` / `dictation.webp` | New Agent composer: “Run the smoke test on the cart.” with dictation active | `.cache/task/captures/dictation.png.note` |

The captures use only synthetic plan/vitals and neutral workspace/prompt names. The isolated debug build cannot load its dictation model (`Failed to load the model` on stop), so the screenshot honestly shows the live recording state but not a recognized transcript or the Cancel/Undo transition. Do not treat the lab as end-to-end dictation verification.

## Public muxr-cloud site

- Updated the existing Usage card copy to call out shared readings, projected run-out colour, and when retained readings were captured.
- Updated the existing whole-farm story to mention pinning spaces at the top of Home. Existing dictation copy already explains Cancel and five-second Undo.
- Did not add a new pinning image or replace the Usage/Dictation images: those screens are generated from the locked marketing source. Their existing Usage artwork still contains its old provider label. Refreshing those assets needs the authorized capture/import flow; do not work around it by adding untracked screen files or changing the lock. Recommended future source: muxr commit `323e4df46d02939d304cb00b9571c3c9eb1111f4`, or the final release/squash commit chosen for the next marketing lock.
- Rendered the landing and Watch section at 390×844 and 1440×960. The hero and feature copy wrap without horizontal overflow. Evidence screenshots and notes are in `.cache/task/captures/site-*.png[.note]`.

## Validation

- `apps/mobile` build had already succeeded for the isolated native capture setup; the local app was served by Metro on host port 8095 with only the dedicated emulator's reverse mapping.
- `muxr-cloud`: `npm test` passed (25 tests; `marketing:check` verified 125 locked files); `npm run build` passed.
- Browser QA passed at desktop and mobile widths for the rendered site. Feature copy was read from the Watch section; the existing locked images remain the noted visual gap.
