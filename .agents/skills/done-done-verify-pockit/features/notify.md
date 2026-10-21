# Send a notification from a tool on the computer

Any tool on the machine POSTs `{title, body?, url?, id?}` to the running host's
loopback `/v1/notify` with the bearer token the host minted, and the host seals
a general notice per paired device and fans it out on the same relay push path
as lifecycle notices. Only devices whose notification level is **all** are sent
one, and the answer counts devices fanned out to, not confirmed deliveries.

## Sub-features

- `notify-send` a valid POST answers `202 {"id":…,"delivered_to":N}`; `https`,
  `http://localhost` and tailnet `http` links are accepted.
- `notify-token` the bearer token lives in `$MUXR_HOME/notify-token`, created
  owner-only (mode 600) when the host starts; a missing or wrong token answers
  401, a non-POST method 405.
- `notify-body` an empty title, a link that is not `https`/loopback/tailnet, or
  a non-JSON body answers 400 with a one-line reason.
- `notify-level` a device registered at level `all` is counted; `important`,
  `off`, and a device that unsubscribed are not.
- `notify-android-link` an Android app (no push address) that is connected is
  counted and sent the sealed notice as a `notice` link frame; it raises a local
  alert only when its level is all, and a disconnected one is not counted.
- `notify-loopback` the route is answered on 127.0.0.1 only, and rides the
  artifact download listener rather than opening a second server.
- `notify-web-tap` a web/PWA tap on a delivered notice opens the link the sealed
  envelope carries, through the same URL acceptance the native tap uses; a
  notice without a link opens the app's landing surface (`/`).

## How to get to it (user POV)

From any terminal on the computer, with the host running:

```sh
curl -X POST http://127.0.0.1:8793/v1/notify \
  -H "Authorization: Bearer $(cat ~/.muxr/notify-token)" \
  -H 'Content-Type: application/json' \
  -d '{"title": "Decision needed", "body": "Pick a layout", "url": "https://example.com/a"}'
```

## Driving it with the private stack

Preconditions: a **non-`--fake`** host from a named lab Herdr session (the route
is started by the artifact listener inside the Herdr session source, so the
`--fake` host from `../SKILL.md` never serves it), `MUXR_HOST_HTTP_PORT` set to
a private port so nothing touches 8793, and a paired device that registered for
push at a level.

1. Start the lab session and host as the iOS path in `../SKILL.md` does, but
   with `MUXR_HOST_HTTP_PORT=<private>`; wait for `link relay: online`.
   `ls -l "$MUXR_HOME/notify-token"` shows mode `600`.
2. Pair a device (the launch's `muxr pair` flow, or a stand-in device that pairs
   and then sends `pair.complete`/`pair.verified` over the real link), then have
   it send `push.subscribe` with `level: "all"`. The host's authority file now
   carries `"pushLevel":"all"` for that device.
3. `curl -X POST http://127.0.0.1:<private>/v1/notify -H "Authorization: Bearer
   $(cat "$MUXR_HOME/notify-token")" -H 'content-type: application/json'
   -d '{"title":"Decision needed","body":"Pick a layout","url":"https://example.com/a","id":"k-1"}'`
   answers `202 {"id":"k-1","delivered_to":1}`.
4. Re-register that device at `important`, then `off`, then `push.unsubscribe`,
   repeating the POST: each answers `202` with `"delivered_to":0`.
5. Failure paths: no token and a wrong token answer `401`; `{"title":""}`,
   `"url":"http://192.168.1.2/a"` and `"url":"http://127.0.0.1.attacker.example/a"`
   answer `400`; a `GET` answers `405`. `ss -ltn` shows the port bound to
   `127.0.0.1` only.

### Android link alert

The `board-alert` journey in `.done-done.yaml` drives `notify-android-link` end
to end: `boardAlertLab.mjs` pairs a release APK on an owned emulator to a fake
stack through the `muxr://pair` link, posts at the default level (counted, not
shown), turns on Settings > Notifications > "An agent finishes", leaves the app
and posts again; the shade and `dumpsys notification` show the second alert.

### Web/PWA tap

Pair the lab PWA as `lab-browser-pairing.md` describes, turn Settings >
Notifications > Browser notifications on, and set the alert level to all.
`POST /v1/notify` with `url` set to a same-origin loopback route
(`http://127.0.0.1:<web>/settings/notifications`): the real relay sends it to
the browser's web-push endpoint, and tapping the real Chrome notification
(`OPEN`) navigates the standalone window to that route. Repeat without `url`
and the tap lands on `/`. The tap must be the browser notification's activation
(on the lab display, an X11 click on it), never a direct call into the worker.

## Gotchas

- `delivered_to` is fan-out, not delivery: it counts the devices the host sealed
  for, so a `202` with `0` is the normal answer when nobody is set to **all**.
  A connected Android app is counted whatever its level (the host cannot see
  it); the app drops the notice unless it is set to all.
- The relay treats a push id as an at-most-once key, and the host derives it from
  your `id`, so the same `id` twice notifies a device once.
- A sealed notice wider than the relay's 2 KB push data budget drops the link
  and keeps the text.
