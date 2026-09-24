#!/usr/bin/env node
/**
 * Publish the tarballs `release/pack.mjs` wrote, platform package first, and
 * wait for the registry to serve each before the next goes out, so
 * `@desklink/host` never names an engine npm does not have.
 *
 *   node release/publish.mjs --dry-run   # everything but the upload
 *   node release/publish.mjs             # needs `npm login` with publish rights on the scope
 *
 * A version already on npm with the same bytes is skipped; with different
 * bytes it is refused, since npm never lets a version be replaced.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dryRun = values['dry-run'];
const out = join(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: packageRoot, encoding: 'utf8' }).trim(), 'dist-desklink');
const { name, version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

const manifestOf = (tarball) => JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
const host = join(out, `desklink-host-${version}.tgz`);
if (!existsSync(host)) throw new Error(`missing ${host}: run release/pack.mjs first`);
const platforms = Object.entries(manifestOf(host).optionalDependencies ?? {});
if (platforms.length === 0) throw new Error(`${host} names no engine package; it was not packed by release/pack.mjs`);
const order = platforms.map(([platform, pinned]) => {
    if (pinned !== version) throw new Error(`${name}@${version} pins ${platform}@${pinned}`);
    return { spec: `${platform}@${version}`, tarball: join(out, `${platform.replace(/^@/, '').replace('/', '-')}-${version}.tgz`) };
});
order.push({ spec: `${name}@${version}`, tarball: host });

function npm(args, { allowMissing = false, timeout = 20000 } = {}) {
    const result = spawnSync('npm', args, { encoding: 'utf8', timeout });
    if (result.status === 0) return result.stdout.trim();
    if (allowMissing && /E404/.test(result.stderr)) return undefined;
    throw new Error(`npm ${args.join(' ')} failed: ${(result.stderr || result.error?.message || 'no output').trim().slice(-400)}`);
}
const published = (spec) => {
    const value = npm(['view', spec, 'dist.integrity', '--json'], { allowMissing: true });
    return value ? JSON.parse(value) : undefined;
};

for (const { spec, tarball } of order) {
    if (!existsSync(tarball)) throw new Error(`missing ${tarball}: run release/pack.mjs first`);
    const manifest = manifestOf(tarball);
    if (`${manifest.name}@${manifest.version}` !== spec) throw new Error(`${tarball} holds ${manifest.name}@${manifest.version}, not ${spec}`);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const existing = published(spec);
    if (existing === integrity) {
        process.stdout.write(`${spec} is already on npm with these bytes; skipped\n`);
        continue;
    }
    if (existing !== undefined) throw new Error(`${spec} is already on npm with different bytes; bump the version instead`);
    npm(['publish', tarball, '--access', 'public', ...(dryRun ? ['--dry-run'] : [])], { timeout: 180000 });
    if (dryRun) {
        process.stdout.write(`${spec} would be published from ${tarball}\n`);
        continue;
    }
    // The registry is eventually consistent; the next package waits for this one.
    let seen;
    for (let attempt = 0; attempt < 20 && seen !== integrity; attempt += 1) {
        if (attempt > 0) await new Promise((done) => setTimeout(done, 3000));
        seen = published(spec);
    }
    if (seen !== integrity) throw new Error(`${spec} was published but the registry does not serve these bytes yet; re-run to confirm`);
    process.stdout.write(`published ${spec}\n`);
}
