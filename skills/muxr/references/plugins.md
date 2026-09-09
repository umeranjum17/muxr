# muxr plugins: author, install, debug, override

Create, modify, validate, install, and safely override muxr plugins using the
public package contract. Bundled and third-party plugins use the same contract,
including bounded app-rendered code and diff views with syntax highlighting —
never plugin HTML.

The full manifest contract (slots, primitives, actions, RPCs, streams,
capabilities) is NOT duplicated here: run `muxr plugin docs` and read the
printed PLUGINS.md. Working examples ship in the package's `plugins/`
directory.

## When to use

When asked to create, modify, install, debug, or replace a muxr plugin or
realtime voice provider.

## Command loop

```bash
muxr plugin docs
muxr plugin create <name>
muxr plugin clone <bundled-plugin-id> [destination]
muxr plugin check <path>
muxr plugin dev <path> [--web]
muxr plugin call <path> <contribution-id> [--input '<json>']
muxr plugin list
muxr plugin install <local-path|owner/repo[/subdir][@ref]|npm:<name>@<version>>
muxr plugin update <same-spec>
muxr plugin remove <plugin-id>
```

## Procedure

1. Run `muxr plugin docs` and read the printed PLUGINS.md before editing. Use
   only public slots, primitives, actions, RPCs, streams, and capabilities
   documented there.
2. For a new plugin, start with `muxr plugin create <name>`. For a bundled
   customization, use `muxr plugin clone <plugin-id> [destination]`; never edit
   package-owned files in place because npm updates replace them.
3. Keep provider policy, secrets, filesystem access, and heavy work in the
   plugin backend. Mobile UI stays declarative and provider-neutral.
4. Run `muxr plugin check <path>`. Test RPCs with
   `muxr plugin call <path> <contribution-id> [--input '<json>']`.
5. For a replacement, disable the original first, then link with
   `muxr plugin dev <path>`. If linking fails, immediately restore the original
   with `herdr plugin enable <plugin-id>`. For a new non-replacement plugin,
   run `plugin dev` directly.
6. Document what appears on the phone, host authority, data/secrets, offline
   behavior, compatibility, and disable/remove commands.

## Install sources and trust

`muxr plugin install` accepts a local path, a GitHub `owner/repo[/subdir][@ref]`
spec, or `npm:<name>@<version>`. Installation never runs package lifecycle
scripts. Enabling a plugin is a trust decision: the plugin backend runs
unsandboxed as your user on the host machine. Read the source before enabling
third-party code. The plugin destination must live outside the npm package so
updates cannot remove it.

## Override a bundled plugin

1. `muxr plugin clone <bundled-plugin-id> <destination>` — copies the source
   somewhere npm updates cannot touch.
2. Disable the original, then `muxr plugin dev <destination>`.
3. Rollback at any time with `herdr plugin enable <original-plugin-id>`.

## Pitfalls

- Exactly one enabled plugin may claim a singleton capability such as
  `voice.session`.
- User-owned source should live outside the npm package; direct edits under
  the global package root do not survive updates.
- Secure prompt values belong in write-RPC input, never declarative state or
  rendered output.
- Unknown slots are tolerated at runtime for forward compatibility but
  `plugin check` warns because they usually indicate authoring mistakes.
- Re-run `plugin dev` and reconnect muxr after manifest changes.

## Verify

- `muxr plugin check <path>` succeeds.
- Every declared read/write RPC succeeds through `muxr plugin call` with
  representative bounded input.
- `muxr plugin list` shows the expected plugin root and enabled state.
- The intended surface renders on the phone or emulator, and disabling the
  plugin removes it.
- An npm reinstall plus `muxr setup` preserves the user-owned plugin and
  explicit enabled/disabled choices.
