/**
 * Disposable npm registry for candidate gates.
 *
 * Serves ONE package — the real candidate tarball plus a second version
 * repacked from the same bytes with only its version bumped — with a
 * switchable `latest` tag, and proxies every other package name to the
 * public registry so the candidate's dependencies resolve unchanged. No
 * publish, no npm account, nothing leaves the machine except dependency
 * lookups the public install would make anyway.
 *
 *   const registry = await disposableRegistry({ tarball, host: '0.0.0.0' });
 *   registry.url            // http://<host>:<port>/  (put in .npmrc)
 *   registry.versions       // [candidate, second]
 *   registry.setLatest(v)   // move the tag
 *   registry.integrity(v)   // sha512 integrity string npm will verify
 *   await registry.close();
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const UPSTREAM = 'https://registry.npmjs.org';

function sha(algorithm, bytes, encoding) {
    return createHash(algorithm).update(bytes).digest(encoding);
}

function repackWithVersion(tarball, version, scratch) {
    const work = join(scratch, `repack-${version}`);
    spawnSync('mkdir', ['-p', work]);
    const extract = spawnSync('tar', ['-xzf', tarball, '-C', work], { encoding: 'utf8' });
    if (extract.status !== 0) throw new Error(`cannot extract ${tarball}: ${extract.stderr}`);
    const manifestPath = join(work, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const out = join(scratch, `repacked-${version}.tgz`);
    // Deterministic-enough: gzip of the same tree; integrity is computed from
    // the bytes actually served, so reproducibility across runs is not needed.
    const pack = spawnSync('tar', ['-czf', out, '-C', work, 'package'], { encoding: 'utf8' });
    if (pack.status !== 0) throw new Error(`cannot repack ${version}: ${pack.stderr}`);
    return out;
}

/** Bump the patch of an exact version, keeping any prerelease channel suffix. */
export function secondVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(version);
    if (match === null) throw new Error(`not an exact version: ${version}`);
    return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ''}`;
}

export async function disposableRegistry({ tarball, host = '127.0.0.1', port = 0 }) {
    const scratch = mkdtempSync(join(tmpdir(), 'muxr-disposable-registry-'));
    const candidateBytes = readFileSync(tarball);
    const candidate = JSON.parse(spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout);
    const name = candidate.name;
    const second = secondVersion(candidate.version);
    const secondBytes = readFileSync(repackWithVersion(tarball, second, scratch));
    const packages = new Map([
        [candidate.version, { manifest: candidate, bytes: candidateBytes }],
        [second, { manifest: { ...candidate, version: second }, bytes: secondBytes }],
    ]);
    let latest = candidate.version;
    let baseUrl = '';

    const packument = () => ({
        name,
        'dist-tags': { latest },
        versions: Object.fromEntries([...packages].map(([version, entry]) => [version, {
            ...entry.manifest,
            _id: `${name}@${version}`,
            dist: {
                tarball: `${baseUrl}${name}/-/${name.split('/').pop()}-${version}.tgz`,
                integrity: `sha512-${sha('sha512', entry.bytes, 'base64')}`,
                shasum: sha('sha1', entry.bytes, 'hex'),
            },
        }])),
        time: Object.fromEntries([...packages.keys()].map((version) => [version, new Date().toISOString()])),
        modified: new Date().toISOString(),
    });

    const server = createServer(async (req, res) => {
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const encodedName = name.replace('/', '%2f');
        if (req.method === 'POST' && path.startsWith('/__gate/latest/')) {
            const version = path.slice('/__gate/latest/'.length);
            if (!packages.has(version)) { res.writeHead(404); res.end('unknown version'); return; }
            latest = version;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ latest }));
            return;
        }
        if (path === `/${name}` || path === `/${encodedName}` || path === `/${name.replace('/', '%2F')}`) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(packument()));
            return;
        }
        const tarballMatch = new RegExp(`^/${name}/-/${name.split('/').pop()}-(.+)\\.tgz$`).exec(path);
        if (tarballMatch !== null) {
            const entry = packages.get(tarballMatch[1]);
            if (entry === undefined) { res.writeHead(404); res.end('no such tarball'); return; }
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(entry.bytes.length) });
            res.end(entry.bytes);
            return;
        }
        // Everything else is a dependency: pass the request upstream untouched.
        try {
            const upstream = await fetch(`${UPSTREAM}${req.url ?? '/'}`, {
                headers: { accept: req.headers.accept ?? 'application/json', 'accept-encoding': 'identity' },
                redirect: 'follow',
            });
            const body = Buffer.from(await upstream.arrayBuffer());
            res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(body.length) });
            res.end(body);
        } catch (cause) {
            res.writeHead(502, { 'content-type': 'text/plain' });
            res.end(`upstream unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const bound = server.address();
    baseUrl = `http://${host}:${bound.port}/`;
    return {
        url: baseUrl,
        port: bound.port,
        name,
        versions: [candidate.version, second],
        integrity: (version) => `sha512-${sha('sha512', packages.get(version).bytes, 'base64')}`,
        setLatest: (version) => { if (!packages.has(version)) throw new Error(`unknown version ${version}`); latest = version; },
        latest: () => latest,
        close: () => new Promise((resolve) => server.close(() => { rmSync(scratch, { recursive: true, force: true }); resolve(); })),
    };
}

// Standalone process: a gate that blocks on spawnSync cannot host the
// registry in its own event loop, so it spawns this and reads one JSON line.
//   node disposableRegistry.mjs --tarball=<tgz> [--host=0.0.0.0] [--port=0]
if (process.argv[1] !== undefined && /disposableRegistry\.mjs$/.test(process.argv[1])) {
    const arg = (name) => process.argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3);
    const tarball = arg('tarball');
    if (tarball === undefined) { process.stderr.write('usage: --tarball=<candidate.tgz> [--host=] [--port=]\n'); process.exit(2); }
    const registry = await disposableRegistry({ tarball, host: arg('host') ?? '127.0.0.1', port: Number(arg('port') ?? 0) });
    process.stdout.write(`${JSON.stringify({ url: registry.url, port: registry.port, name: registry.name, versions: registry.versions, integrity: Object.fromEntries(registry.versions.map((version) => [version, registry.integrity(version)])) })}\n`);
    const stop = () => { void registry.close().then(() => process.exit(0)); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
