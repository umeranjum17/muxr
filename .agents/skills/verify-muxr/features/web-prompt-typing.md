# Type and send prompts in the web app without a crash

In the web app (a Chrome tab or the installed PWA) a person opens an agent,
taps Prompt, types through the phone keyboard and sends. The screen stays up
and the reply shows. Before the fix, `useDraft` wrote the typed draft into the
session catalog on every keystroke, from inside a React effect. Each write
re-rendered every catalog consumer within the same commit. On Android Chrome
the keystrokes arrive before React settles, so the nested updates added up and
React threw #185 ("Maximum update depth exceeded"). The screen then showed
"Something went wrong" with Retry. The thrower in the stack is
`KernelNotifications`, but it is only the next setState in line.

## Sub-features

- `type` while a prompt is typed, the session catalog takes one draft write at
  the empty→text step and one debounced write two seconds after typing stops,
  never one per keystroke.
- `send` after Send the composer is empty and the stored draft is cleared. The
  sent text does not come back as a draft.
- `leave` leaving the agent with an unsent prompt still keeps it as the draft.
- `no-185` five keyboard sends in a row at 270 dp show each reply with no error
  screen in a Chrome tab. At 393 dp nothing changes.

## How to get to it (user POV)

Pair a browser, open an agent from Home, tap Prompt so the keyboard opens, type
a line and press Enter. Repeat. The agent's reply appears in the terminal each
time.

## Driving it with the private stack

Preconditions: the real Herdr lab (`scripts/diagnostics/application/linkHerdrLab.mjs`
through `HERDR_LAB_HELPER`) with an OpenCode agent, and a task-owned Android
emulator under the shared lock. Desktop Chrome does not reproduce the crash:
its keystrokes never outrun React (see Gotchas).

1. Export the web app with `EXPO_PUBLIC_MUXR_LAB_PAIR=1` (as `yarn web:export`
   does, into a scratch dir) and serve it with
   `scripts/diagnostics/application/serveWebExport.mjs` on a non-8792 port.
2. On the emulator, `wm size 1080x2376` and `wm density 640` (270 dp).
   `adb reverse` the web port and the lab relay port, then open the export in
   Chrome.
3. Reach Chrome's page over `adb forward tcp:<p> localabstract:chrome_devtools_remote`
   with `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:<p>`. Pair it with
   `window.__MUXR_LAB_PAIR__(<browser link>)` (`lab-browser-pairing.md`) and open
   the agent.
4. Tap Prompt with `adb shell input tap` so Gboard opens, type with
   `adb shell input text "Reply%sin%sone%sline…"`, then `input keyevent 66`.
   Read `document.body.innerText` for "Something went wrong" and shoot each
   reply. Main fails within one or two sends. The fix passes five.
5. For a source-mapped stack, run the Metro dev server (`expo start --web`) in
   place of the export. Dev React names the thrower and prints the full #185
   message.

The behaviour is covered by `keeps a prompt being typed off the session
catalog, and a sent one out of it` in
`apps/mobile/sources/catalog/application/sessionSync.integration.spec.ts`.

## Gotchas

- Desktop Chrome, even at 270x594, DPR 4 and 6x CPU throttle, settles React
  between keystrokes. It never reproduces the crash. Use the emulator with Gboard.
- `CI=1 expo start` does not watch files. Restart Metro after each edit, or the
  page keeps the old bundle.
- The dev page lacks the export's `interactive-widget=resizes-content` viewport
  meta (`finalizeWebExport`), so the keyboard resizes it differently.
- `adb shell input text` with no focused field types nothing. Tap Prompt again
  after each send, because Enter closes the keyboard.
