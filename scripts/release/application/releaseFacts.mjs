/**
 * Release facts, derived from constants: what the docs may quote as a
 * number or a command. Nothing here is typed twice — versions come from
 * package.json, lifetimes from the relay and setup domain, the port from
 * the configuration schema, the commands from the demo's shared module.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attributeByKey } from '../../setup/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function releaseFacts() {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const manifest = readFileSync(join(ROOT, 'plugins/control/herdr-plugin.toml'), 'utf8');
    const minHerdr = /^min_herdr_version = "([^"]+)"/m.exec(manifest)?.[1];
    const pairing = await import(pathToFileURL(join(ROOT, 'scripts/setup/domain/dist/pairing.js')).href);
    const relayPairing = await import(pathToFileURL(join(ROOT, 'apps/relay/dist/admission/infrastructure/selfhostPairing.js')).href);
    const relayMachines = await import(pathToFileURL(join(ROOT, 'apps/relay/dist/admission/infrastructure/machineAuthority.js')).href);
    const version = pkg.version;
    const minutes = (ms) => `${Math.round(ms / 60_000)} minutes`;
    const hours = (ms) => `${Math.round(ms / 3_600_000)} hours`;
    const days = (ms) => `${Math.round(ms / 86_400_000)} days`;
    return {
        version,
        package: '@trymuxr/cli',
        releaseTag: `v${version}`,
        minHerdrVersion: minHerdr,
        nodeMinimum: '22',
        defaultRelayPort: attributeByKey('MUXR_RELAY_PORT').default,
        pairingLinkLifetime: minutes(relayPairing.PAIR_TTL_MS),
        browserGrantLifetime: hours(pairing.BROWSER_GRANT_TTL_MS),
        personalGrantLifetime: days(pairing.BROWSER_PERSONAL_GRANT_TTL_MS),
        enrollmentLifetime: minutes(relayMachines.ENROLLMENT_TTL_MS),
        commands: {
            herdrInstall: `herdr plugin install umeranjum17/muxr/plugins/control --ref v${version}`,
            herdrSetupPane: 'herdr plugin pane open --plugin muxr.control --entrypoint setup',
            npmInstall: 'npm install -g --ignore-scripts @trymuxr/cli@latest',
            npmSetup: 'muxr',
        },
        native: {
            androidStableApk: 'https://trymuxr.com/downloads/stable/android',
            androidChecksums: 'https://trymuxr.com/downloads/stable/checksums',
            googlePlayTesting: 'https://play.google.com/apps/testing/com.trymuxr.app',
            iosTestFlight: 'https://testflight.apple.com/join/aJSbs8pN',
            allChannels: 'https://trymuxr.com/downloads',
        },
    };
}

if (process.argv[1] !== undefined && /releaseFacts\.mjs$/.test(process.argv[1])) {
    process.stdout.write(`${JSON.stringify(await releaseFacts(), null, 2)}\n`);
}
