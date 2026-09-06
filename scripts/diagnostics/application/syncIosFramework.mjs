import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The iOS libghostty binary is downloaded at install time and never committed,
 * so this pin is the durable record of which bytes belong in a build: the
 * artifact we publish, the digest of the zip the downloader verifies, and the
 * digest of every library slice a build actually links.
 *
 * Only the slices this project links are pinned: the device slice and the
 * universal simulator slice. The macOS and Mac Catalyst slices are unchanged by
 * this backport and deliberately unverified.
 *
 * No host is assumed anywhere here; the URL is data, not a rule.
 *
 * This runs from postinstall, before anything is built, so it lives beside the
 * native guard it feeds rather than in setup: it and everything it imports have
 * to resolve from source alone, and the setup barrel re-exports compiled domain.
 */
export const IOS_FRAMEWORK = Object.freeze({
    url: 'https://github.com/umeranjum17/libghostty-spm/releases/download/storage.1.2.11-muxr.1/GhosttyKit.xcframework.zip',
    zipSha256: 'd52148c3541036ddaa495cdd8683ac485c894cdf3a96fd84a00d82ac37da1cc9',
    libraries: Object.freeze({
        'ios-arm64': 'bee7072dd5ac4dfa299aef8b0bb6cff0cc85b5ba18406170e07a74cbd7318e97',
        'ios-arm64_x86_64-simulator': '33c2a8c5f74efc10d8e8b33ad4641153cc616749abbd61bc0efa046bf33e94c8',
    }),
    // A simulator slice that lost an architecture still hashes fine on the
    // machine that built it, so the architectures are asserted separately.
    simulatorArchitectures: Object.freeze(['arm64', 'x86_64']),
});

const DOWNLOAD_TIMEOUT_MS = 600000;
const root = new URL('../../../', import.meta.url);
const at = (path) => fileURLToPath(new URL(path, root));
const FRAMEWORK = 'node_modules/expo-libghostty/ios/vendor/Frameworks/GhosttyKit.xcframework';
const STAMP = 'node_modules/expo-libghostty/ios/vendor/Frameworks/.checksum';
const MANIFEST = 'node_modules/expo-libghostty/vendor-manifest.json';
const DOWNLOADER = 'node_modules/expo-libghostty/scripts/download-xcframework.mjs';

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** What the patched manifest pins, which the downloader enforces on the zip. */
export function pinnedManifest() {
    return JSON.parse(readFileSync(at(MANIFEST), 'utf8'))['libghostty-spm'].xcframework;
}

/**
 * Source-level identity, true on every platform: the patched manifest names the
 * artifact this project pins. A Linux checkout has whatever binary the
 * dependency fetched before the patch applied, so bytes are not asserted here.
 */
export function verifyIosPin({ pin = IOS_FRAMEWORK } = {}) {
    const findings = [];
    const manifest = pinnedManifest();
    if (manifest.url !== pin.url) findings.push(`manifest url is ${manifest.url}, expected ${pin.url}`);
    if (manifest.sha256 !== pin.zipSha256) findings.push(`manifest sha256 is ${manifest.sha256}, expected ${pin.zipSha256}`);
    return findings;
}

/**
 * The bytes a build links, recomputed from disk. The upstream install hook is
 * not platform-gated, so a Linux checkout also holds an extracted framework —
 * but it is whatever the manifest named before the patch applied, and nothing
 * there links or validates it. Only a Darwin build does, which is why these
 * digests are asserted there while the pin itself is asserted everywhere. The
 * install stamp beside the framework is a skip-the-download hint, not evidence
 * that the right binary is present.
 */
export function verifyIosLibraries({ pin = IOS_FRAMEWORK, architectures = true } = {}) {
    const findings = [];
    for (const [slice, expected] of Object.entries(pin.libraries)) {
        const library = at(`${FRAMEWORK}/${slice}/libghostty.a`);
        if (!existsSync(library)) { findings.push(`${slice}/libghostty.a is missing`); continue; }
        const actual = digest(library);
        if (actual !== expected) findings.push(`${slice}/libghostty.a is ${actual}, expected ${expected}`);
        if (!architectures || !slice.includes('simulator')) continue;
        const lipo = spawnSync('lipo', ['-archs', library], { encoding: 'utf8', timeout: 30000 });
        if (lipo.error !== undefined) { findings.push(`lipo could not read ${slice}: ${lipo.error.message}`); continue; }
        const present = lipo.status === 0 ? lipo.stdout.trim().split(/\s+/) : [];
        for (const architecture of pin.simulatorArchitectures) {
            if (!present.includes(architecture)) findings.push(`${slice} is missing the ${architecture} simulator architecture`);
        }
    }
    return findings;
}

/**
 * A dependency's own install hook runs before this project's, so the framework
 * is fetched from the unpatched manifest and the patched pin never takes effect
 * on its own. Re-running the upstream downloader after the patch is what makes
 * a fresh install self-healing; it verifies the zip before extracting and is a
 * no-op when the stamp already matches.
 */
export function syncIosFramework({ verifyOnly = false } = {}) {
    if (process.platform !== 'darwin') return { skipped: 'not darwin' };
    const pin = verifyIosPin();
    if (pin.length > 0) throw new Error(`the pinned iOS framework is not what the manifest names:\n  ${pin.join('\n  ')}`);
    const stamp = existsSync(at(STAMP)) ? readFileSync(at(STAMP), 'utf8').trim() : undefined;
    const stale = stamp !== pinnedManifest().sha256;
    if (stale && !verifyOnly) {
        const download = spawnSync(process.execPath, [at(DOWNLOADER)], { stdio: 'inherit', timeout: DOWNLOAD_TIMEOUT_MS });
        if (download.error !== undefined) throw new Error(`the GhosttyKit.xcframework download could not run: ${download.error.message}`);
        if (download.status !== 0) throw new Error(`the pinned GhosttyKit.xcframework could not be downloaded (exit ${download.status})`);
    }
    const libraries = verifyIosLibraries();
    if (libraries.length > 0) throw new Error(`GhosttyKit.xcframework does not match its pin:\n  ${libraries.join('\n  ')}`);
    return { synced: stale && !verifyOnly, verified: Object.keys(IOS_FRAMEWORK.libraries) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const result = syncIosFramework({ verifyOnly: process.argv.includes('--verify') });
    if (result.skipped !== undefined) process.stdout.write(`[ios] framework check skipped (${result.skipped})\n`);
    else process.stdout.write(`[ios] GhosttyKit.xcframework verified: ${Object.keys(IOS_FRAMEWORK.libraries).join(', ')}\n`);
}
