# Install the CLI without the phone's toolchain

The first wait on the road to a working agent is `npm install -g @trymuxr/cli`.
The CLI bundles `@byokit/reach`, because installing the kit also installs
`react-native-zeroconf` and through it React Native, Metro and Hermes, none of
which a computer runs. `bonjour-service` stays installed: the relay loads it to
publish itself on the LAN.

## Sub-features

- `lean-install` a cold install brings in no `react-native`, `metro` or
  `hermes-compiler`.
- `setup-runs` the installed CLI loads `setup/infrastructure/reach.mjs`, the
  bundle `pack.mjs` writes over the source file of that name.
- `lan-discovery` the installed relay publishes `_muxr._tcp` and a browse finds it.

## Driving it

```sh
done-done run first-install
```

`features/firstInstallLab.mjs` needs `yarn build` and a fresh web export. It packs
the candidate, installs it and the published CLI into empty prefixes with empty
npm caches, then runs the candidate from its prefix. Times are relative: read them
from one run, never across hosts. Writes `install-before-after.txt`,
`installed-cli.txt`, `lan-discovery.txt`, `gate.log` and `steps.json`.
