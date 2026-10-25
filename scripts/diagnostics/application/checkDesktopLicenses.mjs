/**
 * License audit gate for the desktop AppImage. Fails when the AppImage's
 * third-party license inventory is missing or when a listed dependency has
 * a license outside the shared allow-list (the same list the npm CLI packer
 * enforces at build time).
 *
 * Usage: node scripts/diagnostics/application/checkDesktopLicenses.mjs <AppImage|directory>
 * A directory is the already-extracted AppImage root (squashfs-root or the
 * electron-builder linux-unpacked output); an AppImage file is extracted with
 * --appimage-extract into a short scratch dir first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertPermissiveLicense } from '../../release/index.mjs';

const target = process.argv[2];
if (target === undefined) {
    process.stderr.write('usage: checkDesktopLicenses.mjs <AppImage|directory>\n');
    process.exit(1);
}

let distRoot = resolve(target);
let scratch;
if (statSync(distRoot, { throwIfNoEntry: false })?.isFile() === true) {
    scratch = mkdtempSync(join(tmpdir(), 'mxr-lic-'));
    try {
        execFileSync(distRoot, ['--appimage-extract'], { cwd: scratch, stdio: 'ignore' });
    } catch (error) {
        fail(`license audit: could not extract ${distRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
    distRoot = join(scratch, 'squashfs-root');
}

function fail(message) {
    process.stderr.write(`${message}\n`);
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
}

const mac = distRoot.endsWith('.app');
const appRoot = mac ? join(distRoot, 'Contents', 'Resources', 'app') : join(distRoot, 'resources', 'app');
const inventoryPath = join(appRoot, 'THIRD_PARTY_LICENSES.json');
if (!existsSync(inventoryPath)) fail(`license audit: AppImage inventory missing (looked for ${inventoryPath})`);

let inventory;
try {
    inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
} catch (error) {
    fail(`license audit: AppImage inventory at ${inventoryPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (!Array.isArray(inventory.dependencies) || inventory.dependencies.length === 0) {
    fail(`license audit: AppImage inventory at ${inventoryPath} lists no dependencies`);
}
for (const dependency of inventory.dependencies) {
    try {
        assertPermissiveLicense({ name: dependency.name, version: dependency.auditedVersion, license: dependency.license });
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
    if (dependency.licensePath !== undefined) fail(`license audit: inventory leaks a build path for ${dependency.name}`);
}
if (JSON.stringify(inventory).includes('/node_modules/')) fail('license audit: inventory leaks repository paths');
if (!inventory.dependencies.some((dependency) => dependency.name === 'electron')) {
    fail('license audit: AppImage inventory has no electron entry for the Electron/Chromium runtime');
}
// Electron's own notices ship at the AppImage root beside the muxr binary;
// the inventory covers Chromium through them, never a hand-written list.
for (const notice of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    const shippedNotice = mac ? join(appRoot, 'dist', notice === 'LICENSE.electron.txt' ? 'LICENSE' : notice) : join(distRoot, notice);
    if (!existsSync(shippedNotice)) fail(`license audit: ${notice} missing from the desktop package`);
}
const licenseDir = join(appRoot, 'LICENSES', 'npm');
for (const dependency of inventory.dependencies) {
    if (dependency.licenseFile === 'none') continue;
    const licenseFile = join(licenseDir, `${dependency.name.replaceAll('/', '__')}@${dependency.auditedVersion}.txt`);
    if (!existsSync(licenseFile)) fail(`license audit: license text missing for ${dependency.name}@${dependency.auditedVersion} (${licenseFile})`);
}

if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
const electron = inventory.dependencies.find((dependency) => dependency.name === 'electron');
process.stdout.write(`desktop license audit PASS: ${inventory.dependencies.length} dependencies in ${inventoryPath}, electron ${electron.auditedVersion}\n`);
