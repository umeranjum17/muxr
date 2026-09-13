# Troubleshooting

Each row: what you see → the safe check → what it should say → what to do next. Run every command on the computer unless it says otherwise. `muxr doctor` names the failing phase and never reports "passed" while a row fails.

| What you see | Safe check | Expected | Next |
|---|---|---|---|
| `herdr plugin install` refuses the source or ref | `herdr --version` | 0.8.0 or newer | upgrade Herdr, then rerun the exact command from [Install](install.md) with the pinned `--ref` |
| The plugin build says it cannot resolve `@trymuxr/cli` | `npm view @trymuxr/cli version` | one version | check the network and npm registry access, then rerun the install command |
| A Herdr pane says "no muxr runtime" or "not the recorded version" | `muxr doctor --json` (look at `identity.herdrPlugin`) | `bin` and `version` match `muxr version` | run `muxr update`, or rerun the exact plugin install command with the pinned ref |
| Setup proposes "native app only" | `muxr setup --inspect` | Tailscale connected with Serve free, or your own private HTTPS/`wss://` origin | configure one of those private routes, then `muxr setup --apply-config` (or `muxr`); the native app works now with `muxr pair --native` |
| `muxr pair --browser` says browser hosting is off | `muxr config` | `connectionMode` is browser-capable and `webEnabled` is true | use the [supported configuration change path](../../skills/muxr/references/configuration.md#what-a-change-can-do-now), verify the actual app URL, then pair again |
| Tailscale Serve is occupied or disabled during Apply | `tailscale serve status --json` | muxr owns its target, or it is unused | leave foreign mappings intact. If Serve is disabled, use the exact admin link printed by muxr, then retry `muxr setup --apply-config`. If occupied, choose another private route; never reset another application’s Serve root |
| `muxr doctor` says the relay is not reachable | `curl --max-time 3 http://127.0.0.1:8792/health` | `{"ok":true}` | `muxr daemon restart`, then `muxr doctor` |
| The relay port is in use | use the port shown by `muxr config`; for 8792: `ss -ltnp 'sport = :8792'` (Linux) or `lsof -nP -iTCP:8792 -sTCP:LISTEN` (macOS) | listener matches the registered executable and state directory, or the port is free | confirm [service ownership](../../skills/muxr/references/configuration.md#service-ownership-and-a-second-instance). Leave a foreign listener running and use the supported setup path to select an unused port; a PID or healthy `/health` alone is not ownership |
| A second instance changes the first, or discovery says the name is in use | inspect the [registered service, state path and route](../../skills/muxr/references/configuration.md#service-ownership-and-a-second-instance) | separate service identity, available port, private route and discovery name | keep the working instance running. Use another OS account or computer for a separate managed installation; `MUXR_HOME` alone is not isolation |
| `listen EINVAL` under a long state path | read the socket path named by the error; check its complete byte length | a short owner-only path, including the appended socket filename | use a shorter path for a disposable installation; preserve identity and service registration when relocating an existing one. See [socket-path limits](../../skills/muxr/references/configuration.md#service-ownership-and-a-second-instance) |
| The host service is not running | `muxr daemon status` | active | `muxr daemon start`, then `muxr doctor`; on Linux confirm `loginctl show-user $USER -p Linger` is `yes` for reboot survival |
| The link says the grant expired or access was removed | (in the browser) status pill | **Pair again** | `muxr pair --browser` on the computer, then **Scan QR to pair** in that browser (or open the new link) |
| The pairing page cannot open the camera | the browser's site settings for your computer's address | Camera allowed | allow the camera and tap **Scan QR to pair** again; or scan the QR with your phone's camera app; or **Enter the link** (the QR is the same link) |
| The pairing link does not open, or the browser blocked a pop-up | copy the printed link | the pairing page with the computer name | scan the QR instead, or paste the link into the address bar of the browser you want to pair; links are one-use and expire after a few minutes, so run `muxr pair --browser` again if needed |
| The scanner says the QR is for the native app | the command on the computer | `muxr pair --browser` (not `--native`) | run `muxr pair --browser` for a browser QR; the native QR pairs only the phone app |
| The installed iPhone app asks to pair although Safari was paired | — | — | expected: the installed app has its own storage; run `muxr pair --browser` and scan the fresh QR inside the installed app |
| The phone shows no computer | `muxr doctor` | relay reachable, host running, devices listed | `muxr pair --native` for a fresh QR; on the same Wi-Fi the native app also discovers the computer by itself |
| The terminal stays on "connecting" | `muxr doctor` | host running and authenticated | tap the pill to retry; `muxr daemon restart` if doctor shows the host down |
| Attachments fail to upload | the composer row **didn't upload** | Retry / Discard offered | reconnect, then **Retry**; nothing was sent twice |
| Preview shows "The preview stopped answering" | the dev server on the computer | listening on the port you chose | restore that dev server, then reopen its actual local URL with `muxr browser open` from the owning pane. A relay restart does not restore the app |
| Talk says voice is not set up | `muxr voice status` | the selected provider **Ready** | `muxr voice` on the computer (choose a provider, enter its key hidden), then try again |
| Dictation is greyed out in the browser | — | — | that browser has no built-in speech recognition; use Chrome, Edge, Safari or the native app; typing and Talk still work |
| `muxr setup --apply-config` exits 1 | read the first line | the key and rule (never the value) | read `muxr config` for the winning source, then correct its desired JSON field or override; [configuration recovery](../../skills/muxr/references/configuration.md#troubleshooting) explains legacy-file conflicts |
| `muxr update` ended with a warning about the plugin runtime record | `muxr doctor --json` | `identity.herdrPlugin.version` equals `identity.cli.version` | rerun `muxr update --yes`; if it persists, rerun the plugin install command with the pinned ref |
| Doctor reports corrupt or incomplete state | the file it names | — | stop; back up that exact file before moving it aside. It holds machine identity and pairing authority. `muxr uninstall` is destructive recovery, not first aid |

For the default surface socket, this read-only check prints its path length in bytes:

```bash
printf '%s' "${MUXR_HOME:-$HOME/.muxr}/host/surface/broker.sock" | wc -c
```

Use the actual path from the failure if it differs. Keep the entire path below
100 bytes for room across platforms; changing the relay port cannot fix this error.
Check the registered service's executable and state directory before a repair.
A normal `muxr restart` addresses that service, even if a different `MUXR_HOME`
is set in the terminal. Internal service-command test bypasses are not an
operator isolation recipe.

## Config and terminal recovery

| What you see | Cause | Command / next action |
|---|---|---|
| `config set/apply: not in this build yet` | The v2 file/read side does not include those mutators | `muxr config --schema`; use the [implemented change paths](../../skills/muxr/references/configuration.md#what-a-change-can-do-now). |
| No matching text in this snapshot | Query is absent from retained recent output | Narrow the literal query or tap **Refresh**. Search is limited to 1,000 lines / 256 KiB and 200 matches; older history is not included. |
| Refresh failed | The new host read failed | The old snapshot and capture time remain. Reconnect, then deliberately **Refresh**. |
| Could not focus / Not connected | The host focus request failed or is unavailable | Restore the connection, then retry **Pane actions → Focus in Herdr** with Control. It selects a pane, not an OS window. |
| Paused · Private | The human still owns the agent browser | Choose **Resume control** or **Give back**. Returning to the terminal does not automatically give control back. |

## Report an issue

```bash
muxr report > muxr-report.md
```

The draft contains versions, doctor row names and states, and at most the latest 50 redacted diagnostic events; never prompts, terminal text, paths, credentials or keys. Read it, fill in what happened, then post it yourself at <https://github.com/umeranjum17/muxr/issues/new/choose>.

<!-- release-facts:start -->
| Fact | Value |
|---|---|
| Current release | `@trymuxr/cli@0.1.28` (tag `v0.1.28`) |
| Minimum Herdr | 0.8.0 |
| Minimum Node (npm path) | 22 |
| Default relay port | 8792 |
| Pairing link | one use, expires in 2 minutes |
| Browser access (Control or View-only) | 8 hours |
| Personal Control (installed browser you own) | 30 days |
| Machine enrollment (shared relay) | 5 minutes |
| Native apps | optional: [Android APK](https://trymuxr.com/downloads/stable/android) ([checksums](https://trymuxr.com/downloads/stable/checksums)), [Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app), [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN) — availability depends on store review; [all channels](https://trymuxr.com/downloads) |
<!-- release-facts:end -->

Next: back to [Introduction](introduction.md), or [Configuration](configuration.md) for automation.
