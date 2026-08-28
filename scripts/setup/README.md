# Setup

Owns Machine identity, Pairing Intent, Connection, Enrollment, Ingress, and the daemon that runs the relay and host.

Domain is pure TypeScript. Application orchestrates use cases. Infrastructure maps filesystem, systemd/launchd, Tailscale, Cloudflare, and Herdr. Presentation is the CLI wizard and `muxr up`.

## Tree

```
scripts/setup/
  index.mjs                 public entry (CLI and other contexts import only this)
  domain/                   pairing, connection, enrollment, machine crypto, daemon mode, hosted auth
  application/              self-host use cases, wizard, hosted login/doctor, peers
  infrastructure/           paths, runtime/crypto, self-host state, daemon, Herdr
  presentation/             interactive UI, host/relay up
```

## Aggregates

**Machine** owns key material and Device grants. Corrupt `selfhost.json` is not "not configured": setup refuses to mint a new Machine over it.

**Pairing Intent** owns Client Kind, Device Authority, grant lifetime, the locator, and the device record. Device Id authorizes; display names never enter the grant.

**Connection** owns relay mode/location/role, advertised URL, browser-hosting eligibility, and bind/control-base decisions.

**Enrollment** is a one-time claim to join a shared relay. A pending remote enrollment is invalid once its credential expires.

## Invariants

- Browser grants last eight hours; native grants are durable.
- Native pairings are always `control`. Browser pairings may be `control` or `observe`.
- Display metadata never authorizes.
- DTOs stop at infrastructure; callers invoke domain behavior.
