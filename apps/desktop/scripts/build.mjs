/**
 * Build the desktop app: bundle the muxr host and relay (the same way
 * scripts/release/application/pack.mjs ships them) beside a bundled Electron
 * main, then hand everything to electron-builder to produce the AppImage.
 *
 * Nothing here rewrites host logic: the host and relay are the repo's own
 * built entries, bundled with their native dependencies left external so the
 * Node-API prebuilds in node_modules load at runtime.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleVoiceRuntime } from '../../../scripts/release/application/bundleVoiceRuntime.mjs';

const appDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const root = join(appDir, '..', '..');
const dist = join(appDir, 'dist');

const desktopPackage = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));

// The host and relay bundle everything except these runtime dependencies. The
// list is the desktop package's own dependencies: the same externalisation as
// the packed @trymuxr/cli, kept in one place so packaging cannot drift.
const external = ['electron', ...Object.keys(desktopPackage.dependencies)];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

function failure(label, error) {
    process.stderr.write(`desktop build: ${label} failed\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
}

// 1. The muxr host: the repo's built entry, bundled to one file.
try {
    await build({
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
        logLevel: 'warning',
    });
} catch (error) { failure('host bundle', error); }

// The host loads the realtime voice adapter runtime from a `voice/` folder
// beside its bundle, so stage it the same way the packed CLI does.
try {
    await bundleVoiceRuntime({ root, out: dist, external });
} catch (error) { failure('voice runtime', error); }

// 2. The muxr relay the host runs beside.
try {
    await build({
        absWorkingDir: join(root, 'apps', 'relay', 'dist'),
        entryPoints: ['main.js'],
        outfile: join(dist, 'relay.mjs'),
        preserveSymlinks: true,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external,
        logLevel: 'warning',
    });
} catch (error) { failure('relay bundle', error); }

// 3. The Electron main and preload, with the repo's setup helpers bundled in.
for (const [entry, outfile] of [['src/main.mjs', 'main.mjs'], ['src/preload.mjs', 'preload.mjs']]) {
    try {
        await build({
            absWorkingDir: appDir,
            entryPoints: [entry],
            outfile: join(dist, outfile),
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node22',
            external,
            logLevel: 'warning',
        });
    } catch (error) { failure(`${entry} bundle`, error); }
}

process.stdout.write('desktop build: bundled host, relay, voice, main and preload into dist/\n');

// 4. Package the AppImage. No publish, no upload, ever.
if (process.argv.includes('--package')) {
    try {
        cpSync(join(root, 'LICENSES'), join(appDir, 'LICENSES'), { recursive: true });
        execFileSync('yarn', ['electron-builder', '--linux', 'AppImage', '--publish', 'never'], {
            cwd: appDir,
            stdio: 'inherit',
            env: process.env,
        });
    } catch (error) { failure('electron-builder', error); }
    process.stdout.write('desktop build: AppImage written to apps/desktop/release/\n');
}
