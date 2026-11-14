# A computer joins the host (lab only)

jg-kile slice 9. `muxr computers add <name | user@address[:port]>` joins a computer to the main computer's Herdr Core
and `muxr computers ls [--watch]` lists the joined ones (with their state) and the ssh config names it could offer.
Code: `apps/host/src/computers/`. It is a lab command: it needs `MUXR_COMPUTERS_LAB=1` and a `MUXR_HOME` that is not
the real home, and no user can opt in. Nothing on a phone changes.

## Rules it proves

- Nothing is trusted on first sight. A new host key stops the join and names its fingerprint; the join goes on only with
  `--fingerprint <that one>`. A changed host key is refused with both fingerprints.
- muxr's own key (`<home>/ssh/muxr_ed25519`) is the only key used. When a computer does not accept it, the failure shows the one
  `restrict,from="<address>" <key>` line to add to that computer's `authorized_keys`. Herdr Core joins under `restrict`.
- `hc machine add --install` keeps an older Core as it found it (the journey records this). Bringing it to the pin is muxr's step:
  `hc machine update` when the Core is older and the protocol generation matches. The agent keeps running; no prompt, no error.
- A cut link shows offline within 60 s and ready again within 30 s (polled through `hc machine ls`; Core has no machine event).
- Words only, not run on the real thing: the Mac app bundle ("Update Herdr Core on the Mac"), a newer protocol generation
  ("refused: update muxr"), and the stops-at-logout warning (Core's `keeps_running_after_logout` is absent on 0.1.19, so a
  plain-sshd box shows no warning; the field is read only when Core sends it).

## Run

```sh
yarn build
done-done verify computers-join --outcome "<claim>"
```

Needs Docker (the image `muxr-lab-sshd:1`, debian:12 with openssh-server, is built on first use) and the pinned lab Herdr Core
(`perf/lib/herdrCoreLab.mjs`). The journey starts two containers with real `sshd`, a private lab Core, and an ssh shim in that
Core's PATH so its ssh reads the lab's own config. It removes what it starts. `journey.log` holds every PASS/DEFECT line,
the `--install` finding and the footprint (container memory and CPU before and after a join, Core's disk on the box).

Break test: with the `hc.update` call removed from the built `joinComputer.js`, the journey ends in DEFECT on the pin check.

## Not built yet

The phone and web flow, Tailscale devices as known computers, the cloud join, Update all, and a run on real logind.
