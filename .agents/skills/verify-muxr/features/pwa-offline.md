# Reload the installed PWA with no network

The installed web client keeps its own app shell, so a reload or cold start
with no network paints the muxr UI instead of the browser's error page. The
worker is registered at boot, precaches a build-versioned shell, serves
navigation network-first with the cached shell as fallback, and replaces the
cached build on the next online load (a new build installs a new worker and
deletes the old caches).

## Sub-features

- The worker registers on every web load, not only after push subscribe.
- Navigation is network-first; a failed navigation falls back to the cached
  `/index.html`, and the shell's hashed `/_expo/` and `/assets/` files are
  served cache-first so the app boots offline.
- A new web build changes `sw.js` (its `SHELL_VERSION` is the shell hash), so
  the next online load installs the new worker, precaches the new shell under
  `muxr-shell-<hash>`, and deletes the previous caches on activate.
- Relay, link, API and `/health` traffic is never cached.
- Push and notification-click behaviour is unchanged.

## How to get to it (user POV)

Install the web client to the home screen (or open the exported build in a
standalone window), let it load once online, then drop the network and reload
or relaunch. The shell and the app's own offline/reconnecting state appear; no
browser error page.

## Driving it with the private stack

Preconditions: follow `../SKILL.md` Launch so the stack is private; build the
export first (`yarn build && yarn web:export:selfhost`). Serve that very
`apps/mobile/dist` from the owned relay (`MUXR_WEB_ROOT=…/apps/mobile/dist`),
so the app runs same-origin as it does in production.

1. Start the owned relay serving the export and read its port from the child's
   own stdout line, exactly as the SKILL Launch does. Confirm
   `curl -fsS http://127.0.0.1:<port>/sw.js` prints `const SHELL_VERSION = '<16 hex>'`
   (the build replaced the `__MUXR_SHELL_VERSION__` token) and
   `curl -fsS http://127.0.0.1:<port>/index.html` is `no-store`.
2. Drive a private standalone window: launch a Chrome with
   `--app=http://127.0.0.1:<port>/` and a task-owned `--user-data-dir` inside a
   private Xvfb display, then point chrome-devtools-axi at it with
   `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:<debug-port>`. In the page,
   `matchMedia('(display-mode: standalone)').matches` must be `true`.
3. `chrome-devtools-axi resize 393 844`, load `/`, and assert from
   `navigator.serviceWorker.getRegistration()` that a worker is active and
   controlling, and that `caches.keys()` holds `muxr-shell-<hash>` with
   `/index.html` plus the referenced `/_expo/` and `/assets/` URLs.
4. Stop the owned relay (kill only that exact PID), `location.reload()`, and
   assert the page still renders (`document.getElementById('root')` has
   children, the title is `muxr`) with no browser error page. Capture light and
   dark at 393 px.
5. Restart the relay (same port, so the origin and cache still match), reload,
   and assert the app renders online again.
6. Update proof: change one byte of the entry bundle (rebuild the export),
   reload online, wait for the new worker to activate, then assert the page's
   entry script hash changed, `caches.keys()` shows only the new
   `muxr-shell-<hash>`, and the old cache is gone.
7. Record the offline→online transition as a short screen recording (screenshot
   frames through `ffmpeg`) into the evidence folder.

## Gotchas

- A plain tab is not enough evidence: the acceptance asks for the standalone
  window. `--app=` reports `display-mode: standalone`; a headless tab does not.
- The relay must be restarted on the same port, or the new origin has neither
  the worker registration nor the shell cache.
- The shell version is a hash of `index.html`, so any bundle change moves it;
  if you rebuild without a real change the version is identical and no update
  is expected.
- Never let the worker cache API, relay, link or `/health` responses: only the
  navigation document and hashed `/_expo/` and `/assets/` files are shell.
- The muxr worker is not registered in development (`__DEV__`), or the dev
  server's unversioned bundles would be pinned; drive the production export.
