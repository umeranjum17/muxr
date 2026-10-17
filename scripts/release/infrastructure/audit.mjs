import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const permissiveLicenses = new Set([
    '0BSD',
    'Apache-2.0',
    'BlueOak-1.0.0',
    'Apache2',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'CC0-1.0',
    // caniuse-lite ships CC-BY-4.0 attribution-licensed browser data through
    // the peer-installed react-native closure; Python-2.0 is the PSF license
    // on argparse reached in the audited workspace closure.
    'CC-BY-4.0',
    'ISC',
    'MIT',
    'MPL-2.0',
    'Python-2.0',
    'Unlicense',
]);

export function assertPermissiveLicense({ name, version, license }) {
    // npm license fields carry SPDX expressions (for example type-fest's
    // "(MIT OR CC0-1.0)" or node-forge's "(BSD-3-Clause OR GPL-2.0)"). OR is
    // the recipient's choice, so an expression is approved when any one
    // alternative is fully allow-listed, while every atom of an AND still
    // applies. A plain copyleft or unapproved license keeps failing.
    const ids = Array.isArray(license) ? license : [license];
    const approved = (id) => String(id).replace(/[()]/g, '')
        .split(/\s+OR\s+/)
        .some((alternative) => alternative.split(/\s+AND\s+/).every((atom) => permissiveLicenses.has(atom)));
    if (ids.length && ids.some(approved)) return;
    const reason = /(?:^|[^A-Z])(?:A?GPL|LGPL)/i.test(String(license)) ? 'copyleft' : 'unknown/non-approved';
    throw new Error(`license audit: ${reason} license ${license || '<missing>'} for ${name}@${version}`);
}

export function packagePathFromInput(root, input) {
    const absolute = resolve(root, input);
    const marker = `${sep}node_modules${sep}`;
    const index = absolute.lastIndexOf(marker);
    if (index < 0) return undefined;
    const parts = absolute.slice(index + marker.length).split(sep);
    const name = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    return name ? join(absolute.slice(0, index + marker.length), ...name.split('/'), 'package.json') : undefined;
}

export function packageInfoFromPath(packagePath, bundled, { allowDeclaredOnly = false } = {}) {
    if (!existsSync(packagePath)) throw new Error(`license audit: missing package metadata for bundled input`);
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    const license = typeof pkg.license === 'string' || Array.isArray(pkg.license) ? pkg.license : '';
    assertPermissiveLicense({ name: pkg.name, version: pkg.version, license });
    const packageDir = dirname(packagePath);
    const licenseName = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'COPYING'].find((file) => existsSync(join(packageDir, file)));
    if (licenseName !== undefined) return { name: pkg.name, auditedVersion: pkg.version, license, bundled, licensePath: join(packageDir, licenseName) };
    if (!allowDeclaredOnly) throw new Error(`license audit: no license text for ${pkg.name}@${pkg.version}`);
    return { name: pkg.name, auditedVersion: pkg.version, license, bundled, author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name, licenseFile: 'none' };
}
