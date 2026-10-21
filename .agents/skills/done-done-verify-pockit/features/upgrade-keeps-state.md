# Keep pairing and settings across an app upgrade

Updating the phone app in place keeps everything the user set up: the phone is
still paired with its computer, Home loads without a pair screen, and stored
settings (theme, text size, dismissed cards) read back unchanged. Run this for
any change to on-device storage, above all a major bump of
`react-native-mmkv` or `expo-secure-store`.

## Sub-features

- `upgrade-keeps-pairing` the link grant survives `adb install -r`; Home shows
  the computer connected with no pair screen.
- `upgrade-keeps-settings` MMKV-backed settings set on the old build read back
  on the new build.
- `upgrade-fresh-pair` the new build still pairs from a cleared install.
- `upgrade-journey` `scripts/diagnostics/application/checkUpgradeJourney.mjs` drives
  the whole thing on a real phone: the old release installed and paired, theme
  and text size set, the candidate installed over it, the settings read back,
  the agent's terminal opened, and a cleared install paired again.

## How to get to it (user POV)

- Install the current release, pair, change Theme and Text size, dismiss a Home
  card, then update the app from the store and open it.

## Driving it with the private stack

Preconditions:

- A guarded Herdr lab with a real relay and host, as `computer-failure.md`.
- Two release APKs from `node perf/buildPrApk.mjs <out>`, one from `origin/main`
  and one from the candidate, signed by the same key: copy the first build's
  `test.keystore` into the second out folder before building, or `install -r`
  fails on the signature.
- An owned emulator `SERIAL`; pair from the `muxr://pair#<offer>` deep link
  (offer off the host's `pair.sock`) after `adb -s $SERIAL reverse` of the
  relay port.
- Pass: on main, pair, set Dark and 14 pt, dismiss the notification card,
  capture Home and Settings > Appearance; `adb -s $SERIAL install -r` the
  candidate (no `pm clear`); Home is connected, Appearance still reads Dark and
  14 pt, the card stays dismissed. Then `pm clear`, pair again and reach Home.

The same journey on a real phone, one command:

```
UPGRADE_FROM_APK=<old release apk> UPGRADE_TO_APK=<candidate apk> \
  PHONE_SERIAL=<the test phone> \
  node scripts/diagnostics/application/checkUpgradeJourney.mjs <evidence dir> <scratch dir>
```

It installs the old release from scratch, pairs it with the lab host, sets
Theme to Dark and the terminal text size to 20 pt, installs the candidate over
it with `adb install -r`, opens the agent's terminal on the new build, reads
Theme and Text size back on Settings > Appearance, then clears the app and
pairs again. It writes the steps it passed to `steps.json`, the frames it took
to the scratch folder and a `journey.log` to the evidence dir.

## Gotchas

- A release app's `/proc/<pid>/maps` is unreadable; prove which native store
  loaded from `logcat` (`NitroMmkvOnLoad` for mmkv 4) and from `unzip -l` of
  each APK's `lib/x86_64/`.
- `pm clear` drops the pairing too, so the fresh-pair step goes last.
- The shipped release APK carries a signing key the repository does not hold.
  Re-sign it with the lab key (`apksigner sign --ks <key>`) before it can be
  the "old" build, or `install -r` of the candidate fails on the signature.
- `screenrecord` is refused on the test phone: take the journey's frames with
  `adb exec-out screencap` and stitch them with ffmpeg.
