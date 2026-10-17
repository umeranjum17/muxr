import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeDependencies } from './runtimeDependencies.mjs';
import { installedDependencies, licenseInventory, writeThirdPartyInventory } from './licenseInventory.mjs';

/**
 * The desktop AppImage's license inventory. It audits exactly what the
 * AppImage ships through the same generator as the npm CLI packer: the
 * dependencies inlined into the host, relay, voice, main and preload
 * bundles, the installed production dependencies electron-builder copies
 * into resources/app/node_modules, the ccusage/desklink platform entries,
 * and the Electron runtime shell itself. Chromium's own notices ship as
 * Electron's LICENSES.chromium.html at the AppImage root; nothing about
 * Chromium is hand-written here.
 */

function desktopBundleJobs({ root, appDir, dist, external }) {
    return [
        {
            label: 'host bundle',
            root: join(root, 'apps', 'host', 'dist'),
            config: {
                absWorkingDir: join(root, 'apps', 'host', 'dist'),
                entryPoints: ['main.js'],
                outfile: join(dist, 'host.mjs'),
                preserveSymlinks: true,
                define: { 'process.env.MUXR_PACKAGED': '"1"' },
                bundle: true,
                platform: 'node',
                format: 'esm',
                target: 'node22',
                external,
                metafile: true,
                logLevel: 'warning',
            },
        },
        {
            label: 'relay bundle',
            root: join(root, 'apps', 'relay', 'dist'),
            config: {
                absWorkingDir: join(root, 'apps', 'relay', 'dist'),
                entryPoints: ['main.js'],
                outfile: join(dist, 'relay.mjs'),
                preserveSymlinks: true,
                bundle: true,
                platform: 'node',
                format: 'esm',
                target: 'node22',
                external,
                metafile: true,
                logLevel: 'warning',
            },
        },
        {
            label: 'src/main.mjs bundle',
            root: appDir,
            config: {
                absWorkingDir: appDir,
                entryPoints: ['src/main.mjs'],
                outfile: join(dist, 'main.mjs'),
                bundle: true,
                platform: 'node',
                format: 'esm',
                target: 'node22',
                external,
                metafile: true,
                logLevel: 'warning',
            },
        },
        {
            label: 'src/preload.mjs bundle',
            root: appDir,
            config: {
                absWorkingDir: appDir,
                entryPoints: ['src/preload.mjs'],
                outfile: join(dist, 'preload.mjs'),
                bundle: true,
                platform: 'node',
                format: 'esm',
                target: 'node22',
                external,
                metafile: true,
                logLevel: 'warning',
            },
        },
    ];
}

/** Bundle every desktop entry and return the esbuild metafiles for the audit. */
async function bundleDesktopEntries({ root, appDir, dist, external }) {
    // esbuild and the voice bundler load lazily: this module is reachable
    // from the packed CLI's release index, where build-time-only imports
    // must never resolve at user runtime.
    const { build } = await import('esbuild');
    const { bundleVoiceRuntime } = await import('./bundleVoiceRuntime.mjs');
    const bundles = [];
    for (const job of desktopBundleJobs({ root, appDir, dist, external })) {
        try {
            bundles.push({ root: job.root, metafile: (await build(job.config)).metafile });
        } catch (error) {
            throw new Error(`desktop ${job.label} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // The host loads the realtime voice adapter runtime from a `voice/` folder
    // beside its bundle, so stage it the same way the packed CLI does.
    try {
        const voiceResult = await bundleVoiceRuntime({ root, out: dist, external });
        bundles.push({ root, metafile: voiceResult.metafile });
    } catch (error) {
        throw new Error(`desktop voice runtime failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return bundles;
}

/**
 * Audit what the AppImage ships. Throws on a copyleft or unknown/non-approved
 * license, the same allow-list as the CLI packer.
 */
function auditDesktopDependencies({ root, appDir, bundles }) {
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const desktopPackage = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
    return [
        ...licenseInventory({ bundles, root, rootPackage, declared: runtimeDependencies(root) }),
        ...installedDependencies({ root, declared: { electron: desktopPackage.devDependencies.electron }, bundledNames: new Set() }),
    ];
}

/**
 * Stage the inventory where electron-builder picks it up: beside the app's
 * other legal files, so it lands at resources/app/THIRD_PARTY_LICENSES.json
 * inside the AppImage.
 */
function writeDesktopLicenseInventory({ appDir, version, dependencies }) {
    writeThirdPartyInventory({
        inventoryPath: join(appDir, 'THIRD_PARTY_LICENSES.json'),
        licenseDir: join(appDir, 'LICENSES', 'npm'),
        artifact: `@muxr/desktop@${version}`,
        dependencies,
    });
}

/** Bundle, audit and write the desktop inventory beside the app's legal files. */
export async function desktopLicenseInventory({ root, appDir, dist, external }) {
    const bundles = await bundleDesktopEntries({ root, appDir, dist, external });
    const desktopPackage = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
    const dependencies = auditDesktopDependencies({ root, appDir, bundles });
    writeDesktopLicenseInventory({ appDir, version: desktopPackage.version, dependencies });
    return dependencies;
}
