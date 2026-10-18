# Pair a phone through the kit files

A cloud computer can pair without a terminal: `muxr pair --handoff` publishes an offer in the kit work directory, then approves only the two words returned by the phone. A computer without setup explains the next command instead of printing ENOENT.

## Sub-features

- Native handoff uses the running host's existing pairing socket and approval path.
- Matching words complete enrollment only after the phone proves its machine link.
- Wrong words, cancellation, and the two-minute deadline leave no new device and remove the offer and words files.
- Handoff works only while the computer has no paired device; a second handoff is refused before any offer is written.
- `muxr up` in self-host mode names `muxr setup` when configuration is missing.

## How to get to it (user POV)

Run `muxr pair --handoff` from the kit's `workDir` on the user's computer. The phone collects `.byokit/outbox/muxr-pair-<random>.json`, reads its `offer`, and dials over the user's tailnet. The JSON's optional `notice` is the ran-out line the computer prints above the next QR; handoff mode prints no QR, so the line is carried as that next offer's `notice` field, present only on the offer that follows a code that ran out before a yes. After showing its two words, the phone calls kit `deliver` with the offer's `wordsFile` and those words as UTF-8 bytes. `muxr pair --help` documents the JSON contract; no kit dependency is required by muxr.

## Driving it with the private stack

Preconditions: the baseline private relay and fake host from `../SKILL.md`; a separate non-default Herdr lab shell; all processes and their ports are owned by the run. The phone side may be a small Node script using the real `@byokit/pair` `pairWithOffer` and `DeviceLink`, as this feature adds no phone UI.

1. Record `muxr status` and `muxr devices list` before pairing. Run the public CLI `node <repo>/scripts/cli.mjs pair --handoff` with stdin ignored, cwd a private kit work directory, and the lab `MUXR_HOME`. Never print the offer JSON.
2. Read the only outbox JSON, assert its byte size is at most 65536 and `version` is 1. Pass `offer` to `pairWithOffer`. In `onWords`, write the returned words to `.byokit/inbox/<wordsFile>` using BYOKit's delivery contract: private temporary file, raw stdin bytes, atomic rename, mode 0600. Do not print words.
3. Once approved, open a `DeviceLink` with the grant, request `pair.complete`, open the returned machine link with the same secret key, wait until online, then request `pair.verified` on the pairing link. Expect the CLI to exit 0. Read `status` and `devices list` again: the new phone appears. Both handoff files must be absent, and CLI output must contain neither words nor offer.
4. On a computer with no paired phone, repeat with a fresh phone key but deliver `wrong words`. Expect the phone's claim to be refused as expired once its code runs out, the CLI to keep waiting for a new code until the two-minute cap or a stop (then exit 1), unchanged device count, and both handoff files absent. With one phone paired, a new handoff must exit 1 with `Handoff pairing is only for the first device` and write no offer.
5. Repeat without returning words (or without dialing at all). After two minutes expect CLI exit 1, unchanged devices and removed offer. If an approval is still pending at two minutes, the CLI does not cancel it: the claim runs out, the phone is refused as expired with `The code ran out. Scan the new QR on your computer` (not declined), and the CLI exits 1 after that run-out. For cancellation, send SIGTERM to only the CLI PID and check the same cleanup.
6. In a clean, task-owned container, not on the desktop, run:

   ```sh
   docker run --rm --network none -v "$PWD:/app:ro" -w /app \
     -e MUXR_MODE=selfhost -e MUXR_HOME=/tmp/muxr-empty \
     node:22 node scripts/cli.mjs up
   ```

   Expect exit 1 and `This computer is not set up yet. Run \`muxr setup\` first.` No ENOENT, relay, host, service, or Herdr startup should occur.

The maintained regression journeys are the handoff flow in `tests/cross-side/linkPairing.integration.test.ts` and the container startup flow in `scripts/setup/infrastructure/selfhost.spec.mjs`. Save sanitized commands, outputs, before/after device counts and exact-PID cleanup in the task evidence directory. There are no phone/PWA screens or motion changes: visual check n/a.

## Gotchas

- The kit work directory is cwd, not `MUXR_HOME`. Kit `deliver` writes raw bytes, not a JSON envelope, to the inbox; its mode/atomic rename contract is in BYOKit `packages/cloud/src/unit.ts` and `machine.ts`.
- Offers refresh in the same outbox file, and each offer names its own `wordsFile`. A file whose words do not match the current code is skipped, not refused: that claim waits until its code runs out and is refused as expired with no grant, so a late yes for a code that ran out cannot answer or break a newer code. A file is dropped and deleted once its code's expiry plus the code length has passed (checked before each read). Collectors should only collect final `.json` names, not temporary atomic-write files.
- This only pairs native phones. Browser flags with `--handoff` are refused. The existing terminal pairing flow is unchanged.
- Never store raw offers, words, device keys, or owner credentials in proof logs. Cleanup owns exact child PIDs and private scratch only. Real Tailscale routing must be reported separately if the private proof uses LAN or loopback instead.
