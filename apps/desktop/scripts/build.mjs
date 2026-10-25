/**
 * Build the desktop app: bundle the muxr host and relay (the same way
 * scripts/release/application/pack.mjs ships them) beside a bundled Electron
 * main, audit every shipped dependency through the shared license inventory
 * generator, then hand everything to electron-builder to produce the AppImage.
 *
 * Nothing here rewrites host logic: the host and relay are the repo's own
 * built entries, bundled with their native dependencies left external so the
 * Node-API prebuilds in node_modules load at runtime.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { desktopLicenseInventory } from '../../../scripts/release/application/desktopLicenseInventory.mjs';
import { runtimeDependencies } from '../../../scripts/release/application/runtimeDependencies.mjs';

const appDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const root = join(appDir, '..', '..');
const dist = join(appDir, 'dist');
const mac = process.argv.includes('--mac');
const developerId = process.argv.includes('--developer-id');
if (mac && process.platform !== 'darwin') throw new Error('Build the macOS DMG on a Mac.');
if (developerId && !mac) throw new Error('--developer-id requires --mac.');

const desktopPackage = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));

function failure(label, error) {
    process.stderr.write(`desktop build: ${label} failed\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
}

// The host, relay and Electron main leave these runtime dependencies external;
// derived from the manifests packing uses so the packed CLI and this AppImage
// cannot drift. The desktop manifest must declare exactly them for
// electron-builder to ship the native runtimes.
const runtimeDeps = runtimeDependencies(root);
const declared = desktopPackage.dependencies ?? {};
const drift = [...new Set([...Object.keys(runtimeDeps), ...Object.keys(declared)])]
    .filter((name) => runtimeDeps[name] !== declared[name]);
if (drift.length > 0) failure('runtime dependency drift', new Error(`apps/desktop/package.json must declare ${drift.join(', ')} exactly as the shared runtime dependencies`));
const external = ['electron', ...Object.keys(runtimeDeps)];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1-3. The muxr host, the relay it runs beside, the Electron main and preload,
// and the license audit. A bundled or installed dependency with a license
// outside the shared allow-list fails the build before packaging. The
// inventory stages beside the app's other legal files so it lands at
// resources/app/THIRD_PARTY_LICENSES.json inside the AppImage.
let dependencies;
try {
    dependencies = await desktopLicenseInventory({ root, appDir, dist, external });
} catch (error) { failure('desktop license inventory', error); }
process.stdout.write(`desktop build: bundled host, relay, voice, main and preload; license audit passed for ${dependencies.length} dependencies -> THIRD_PARTY_LICENSES.json\n`);

// 4. Package locally. Only the explicit Developer ID release enables Apple's
// notarization; ordinary builds are ad-hoc and must never be distributed as trusted.
if (process.argv.includes('--package')) {
    try {
        cpSync(join(root, 'LICENSES'), join(appDir, 'LICENSES'), { recursive: true });
        let target = ['--linux', 'AppImage'];
        if (mac) {
            const electron = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
            for (const notice of ['LICENSE', 'LICENSES.chromium.html']) {
                cpSync(join(electron, 'dist', notice), join(dist, notice));
            }
            target = ['--mac', 'dmg', '--arm64', '--config.mac.notarize=false', '--config.mac.identity=-'];
            if (developerId) target = ['--mac', 'dmg', '--arm64', '--config.forceCodeSigning=true', '--config.mac.notarize=true', '--config.dmg.sign=true'];
        }
        execFileSync('yarn', ['electron-builder', ...target, '--publish', 'never'], {
            cwd: appDir,
            stdio: 'inherit',
            env: process.env,
        });
    } catch (error) { failure('electron-builder', error); }
    process.stdout.write(`desktop build: ${mac ? 'arm64 DMG' : 'AppImage'} written to apps/desktop/release/\n`);
    // The gate checks the packaged layout itself, so a missing inventory or
    // notice in the artifact fails the build, not only the staged copy.
    try {
        execFileSync(process.execPath, [join(root, 'scripts', 'diagnostics', 'application', 'checkDesktopLicenses.mjs'), mac ? join(appDir, 'release', 'mac-arm64', 'muxr.app') : join(appDir, 'release', 'linux-unpacked')], { stdio: 'inherit' });
    } catch (error) { failure('packaged license gate', error); }
}
