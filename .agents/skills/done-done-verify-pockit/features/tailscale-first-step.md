# Tailscale is step 1 of the first run, not a gate

The unpaired first screen (native and PWA) opens on three numbered steps:
**Get Tailscale** (one line: the free app on this device and on the computer,
same account on both, with a **Get Tailscale** store button), **Get muxr on
your computer** (the Linux desktop app), then **Pair with your computer** with
the link field, Connect and Scan. Step 1 is a step, not a gate: the link field
is on the same screen with nothing to tap first. **More ways & timing** still
names HTTPS, user-owned tunnels and local networks as other routes.

Drive and capture the actual shell with
[first-run-browser-steps.md](./first-run-browser-steps.md), including the
Visual check's native/installed-PWA width, font and theme matrix. On a fresh
unpaired client, verify the order Tailscale → muxr on the computer → pair, and
that **Get Tailscale** opens the store (Play Store on Android, App Store on iOS,
tailscale.com/download on the PWA); back out of the store without installing.
Do not install Tailscale or administer any real host for this proof.

Existing Tailscale-specific reachability failure/recovery is separately
covered by [pair-tailscale-unreachable.md](./pair-tailscale-unreachable.md).
