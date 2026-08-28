import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const permissiveLicenses = new Set([
    '0BSD',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'CC0-1.0',
    'ISC',
    'MIT',
    'MPL-2.0',
    'Unlicense',
]);

export function packagePathFromInput(root, input) {
    const absolute = resolve(root, input);
    const marker = `${sep}node_modules${sep}`;
    const index = absolute.lastIndexOf(marker);
    if (index < 0) return undefined;
    const parts = absolute.slice(index + marker.length).split(sep);
    const name = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    return name ? join(absolute.slice(0, index + marker.length), ...name.split('/'), 'package.json') : undefined;
}

export function packageInfoFromPath(packagePath, bundled) {
    if (!existsSync(packagePath)) throw new Error(`license audit: missing package metadata for bundled input`);
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    const license = typeof pkg.license === 'string' ? pkg.license : '';
    if (!permissiveLicenses.has(license)) {
        const reason = /(?:^|[^A-Z])(?:A?GPL|LGPL)/i.test(license) ? 'copyleft' : 'unknown/non-approved';
        throw new Error(`license audit: ${reason} license ${license || '<missing>'} for ${pkg.name}@${pkg.version}`);
    }
    const packageDir = dirname(packagePath);
    const licenseName = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'COPYING'].find((file) => existsSync(join(packageDir, file)));
    if (licenseName === undefined) throw new Error(`license audit: no license text for ${pkg.name}@${pkg.version}`);
    return { name: pkg.name, auditedVersion: pkg.version, license, bundled, licensePath: join(packageDir, licenseName) };
}
