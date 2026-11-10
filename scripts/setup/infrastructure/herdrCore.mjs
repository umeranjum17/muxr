import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch as hostArch } from 'node:os';
import { join } from 'node:path';
import { platform, run, stateDir } from './runtime.mjs';

/**
 * The one Herdr Core release muxr installs. Bump the version and every digest together, from
 * that release's own manifest.json. Plan slice 4 of the Herdr Core move (jg-kile-s4): nothing
 * reads the installed core yet, so no user path calls this until the release that switches.
 *
 * Supported: Linux x86_64 and aarch64. macOS digests are pinned but a Mac run has not proven
 * the install, so it is refused with that reason; Windows has no support.
 */
export const HERDR_CORE_PIN = {
    version: '0.1.19',
    sha256: {
        'linux-x86_64': '4adcfb423d52f24c5cc4a1e2cd2fcad1f62d28bb77876ac472c29082a3eaa424',
        'linux-aarch64': 'f95c34fd7177ed58807d74fe4ee78bb3dc73eb37f21c69496064000a21abcb10',
        'macos-x86_64': '2f95bedae2ca1bf9f9611d61066ef3ac211c62ca08282132d48e287b6da14d08',
        'macos-aarch64': '5338d900adadb6d273b9c8e97027247db3179ccffede10a1793358f16e08d683',
    },
    installable: ['linux-x86_64', 'linux-aarch64'],
};
const RELEASES = 'https://releases.herdr.dev/core';

/** Where the installed binary lives: inside muxr's own state folder, so MUXR_HOME scopes it. */
export const herdrCorePath = () => join(stateDir(), 'herdr-core', 'herdr-core');

/** The release target name for this computer, or why none applies. Throws with the reason. */
function releaseTarget() {
    const os = { linux: 'linux', darwin: 'macos' }[platform()];
    const cpu = { x64: 'x86_64', arm64: 'aarch64' }[hostArch()];
    const name = os && cpu ? `${os}-${cpu}` : `${platform()}-${hostArch()}`;
    if (!HERDR_CORE_PIN.sha256[name]) throw new Error(`Herdr Core ${HERDR_CORE_PIN.version} has no build for ${name}`);
    if (!HERDR_CORE_PIN.installable.includes(name)) {
        throw new Error(`muxr installs Herdr Core on Linux only for now; ${name} is not proven yet (a Mac install has not been run)`);
    }
    return name;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const parse = (text) => text.match(/^hc (\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
const older = (a, b) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

/**
 * What the doctor reports: `{ state: 'ok'|'missing'|'outdated'|'unreadable', version?, detail }`.
 * Anything at or above the pin is ok; the pin is the minimum tested release.
 */
export function herdrCoreStatus(binary = herdrCorePath()) {
    if (!existsSync(binary)) return { state: 'missing', detail: `Herdr Core is missing (${binary})` };
    const result = run(binary, ['--version'], { timeout: 5_000 });
    const found = parse(result.stdout);
    if (!result.ok || !found) return { state: 'unreadable', detail: `${binary} gave no version: ${result.stderr || result.stdout || 'no output'}` };
    const version = found.join('.');
    if (older(found, parse(`hc ${HERDR_CORE_PIN.version}`))) {
        return { state: 'outdated', version, detail: `Herdr Core ${version} is too old; muxr needs ${HERDR_CORE_PIN.version} or newer` };
    }
    return { state: 'ok', version, detail: `Herdr Core ${version}` };
}

/**
 * Download the pinned Herdr Core, hold it to the pinned SHA-256 and to the release manifest,
 * and install it atomically at `herdrCorePath()`. A changed archive, manifest or binary is
 * refused with the cause and leaves any earlier install untouched. `baseUrl` (default
 * MUXR_HERDR_CORE_BASE_URL) is a mirror or loopback fixture: it moves where bytes come from,
 * never which digest they must have.
 * @returns {Promise<{ binary: string, version: string, target: string, sha256: string, reused: boolean }>}
 */
export async function installHerdrCore({ baseUrl = process.env.MUXR_HERDR_CORE_BASE_URL?.trim() || RELEASES } = {}) {
    const { version } = HERDR_CORE_PIN;
    const target = releaseTarget();
    const pinned = HERDR_CORE_PIN.sha256[target];
    const binary = herdrCorePath();
    if (herdrCoreStatus(binary).version === version) return { binary, version, target, sha256: pinned, reused: true };

    const get = async (what, url) => {
        const response = await fetch(url).catch((cause) => { throw new Error(`cannot reach ${what} at ${url}: ${cause.message}`); });
        if (!response.ok) throw new Error(`${what} download failed: HTTP ${response.status} from ${url}`);
        return Buffer.from(await response.arrayBuffer());
    };
    const manifest = JSON.parse((await get('the Herdr Core manifest', `${baseUrl}/${version}/manifest.json`)).toString('utf8'));
    const listed = manifest.targets?.[target]?.sha256;
    if (manifest.version !== version || listed !== pinned) {
        throw new Error(`the Herdr Core release manifest does not match muxr's pin (manifest ${manifest.version} ${listed}; pinned ${version} ${pinned})`);
    }
    const archive = await get('the Herdr Core archive', `${baseUrl}/${version}/herdr-core-${target}.tar.gz`);
    const got = sha256(archive);
    if (got !== pinned) throw new Error(`the Herdr Core archive was refused: its SHA-256 is ${got}, not the pinned ${pinned}; nothing was installed`);

    const dir = join(stateDir(), 'herdr-core');
    const work = join(dir, `.install-${randomBytes(6).toString('hex')}`);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
        writeFileSync(join(work, 'archive.tar.gz'), archive, { mode: 0o600 });
        const untar = run('tar', ['-xzf', join(work, 'archive.tar.gz'), '-C', work, 'herdr-core']);
        if (!untar.ok) throw new Error(`the verified Herdr Core archive would not unpack: ${untar.stderr || untar.stdout}`);
        const staged = join(work, 'herdr-core');
        chmodSync(staged, 0o755);
        const reported = run(staged, ['--version'], { timeout: 5_000 }).stdout;
        if (reported !== `hc ${version}`) throw new Error(`the unpacked binary reports "${reported}", not hc ${version}; nothing was installed`);
        renameSync(staged, binary);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
    return { binary, version, target, sha256: pinned, reused: false };
}
