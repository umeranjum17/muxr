# A pane that closes mid-watch never stops panes opening

A terminal attach re-reads the Herdr tree before it resolves its pane. @byokit/herdr 0.16 never settles a status watch Herdr refuses for an agent pane that closed as the watch opened, so that read (and every attach after it) waited for good while lists and Usage still answered (21 Oct, a 0.2.9 host: no pane opened for 3.5 h until a restart). The host now restarts its Herdr kit when a tree read overruns 20 seconds, and the attach answers.

## Sub-features

- A tree read that overruns 20 s journals `herdr: tree read still waiting after 20s; restarting the herdr kit` once, and concurrent attaches share one restart.
- After the restart, the attach that waited answers, and later attaches answer at normal speed.

## How to get to it (user POV)

- On a busy computer, agents come and go all the time. Open any agent on the phone: the terminal opens, never stuck on connecting. At worst the first open after such a moment waits about 20 seconds.

## Driving it with the private stack

- `node scripts/diagnostics/application/checkHerdrVanishedWatch.mjs` with `HERDR_LAB_HELPER` set (needs `apps/host/dist` built). Against a real lab Herdr, a socket proxy holds one agent pane's status subscribe while the check closes that pane, so Herdr answers `pane_not_found` the way it did on the captain's host. The check passes when the host client's tree read answers, which takes one kit restart. To see it go red, raise `REFRESH_WEDGED_MS` in `apps/host/src/agent/infrastructure/herdrKitClient.ts` past the check's 45 s and rebuild.
- A whole lab host cannot sit behind the proxy (it refuses any socket but its lab session's own), and the race does not fire on an idle lab. For the phone side, pair the release APK with a lab host built from this change and open an agent: it attaches.

## Gotchas

- The real fix belongs in the kit (`socket.js` subscribe: an error frame with id `<id>:sub:…` refuses that subscription). muxr cannot patch the kit for users: `@byokit/herdr` is a runtime dependency installed from npm, not bundled.
- A host journal line `herdr snapshot failed while resolving pp_…: herdr: not connected` in a burst at host stop marks attaches that had been queued behind a wedged read.
