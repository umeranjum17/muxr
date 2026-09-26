/**
 * Web-serving flow check: boots the REAL relay and the REAL static export
 * server against a fixture web root, then asserts delivery behavior over
 * HTTP — MIME types, mutable-entry revalidation, immutable hashed assets,
 * SPA fallback, and /v1/ API passthrough.
 *
 * This replaces source-string assertions ("relay.ts contains ..."): headers
 * are read off live responses, so a regression that breaks serving fails
 * here even when the source still mentions the right strings.
 */
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { waitForRelay } from './waitForRelay.mjs';

const failures = [];
const check = (name, ok, detail = '') => {
    const mark = ok ? 'ok' : 'FAIL';
    const suffix = detail === '' ? '' : ` — ${detail}`;
    process.stdout.write(`${mark}  ${name}${suffix}\n`);
    if (!ok) failures.push(name);
};

const freePort = () => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
    });
});

const root = mkdtempSync(join(tmpdir(), 'muxr-webserve-'));
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-webserve-data-'));
const children = [];
const get = async (base, path) => {
    const response = await fetch(`${base}${path}`);
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
};

const contentType = (response) => response.headers.get('content-type') || '';
const cacheControl = (response) => response.headers.get('cache-control') || '';

try {
    // Fixture web root shaped like a real export: mutable entries plus a
    // hashed asset plus the lazily-fetched wasm engine.
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><script src="/assets/app-a1b2c3d4e5.js"></script></head></html>');
    writeFileSync(join(root, 'sw.js'), '/* push worker */');
    writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"muxr"}');
    writeFileSync(join(root, 'assets', 'app-a1b2c3d4e5.js'), 'console.log("app");');
    writeFileSync(join(root, 'canvaskit.wasm'), Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d]), Buffer.alloc(1024)]));

    const relay = spawn('node', ['apps/relay/dist/main.js'], {
        env: {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_PORT: '0',
            MUXR_RELAY_HOST: '127.0.0.1',
            MUXR_RELAY_DATA_DIR: dataDir,
            MUXR_WEB_ROOT: root,
            // Serving the PWA pins browser origins to where it is published.
            MUXR_ALLOWED_ORIGINS: 'https://desk.example.ts.net',
        },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(relay);
    const relayPort = await waitForRelay(relay);
    const relayBase = `http://127.0.0.1:${relayPort}`;

    // A phone on the Direct SSH route dials the relay through a local forward
    // and presents the relay's own loopback address as its Origin: serving
    // the PWA must not shut it out, while any other origin stays refused.
    const originVerdict = async (origin, host = `127.0.0.1:${relayPort}`) => {
        const response = await fetch(`${relayBase}/relay/v1/hosts`, { headers: { origin, host } });
        return { status: response.status, body: await response.text() };
    };
    check('relay admits its own loopback origin past the origin check', !(await originVerdict(`http://127.0.0.1:${relayPort}`)).body.includes('origin not allowed'));
    check('relay admits the published PWA origin', !(await originVerdict('https://desk.example.ts.net')).body.includes('origin not allowed'));
    check('relay refuses another loopback port as origin', (await originVerdict('http://127.0.0.1:1')).body.includes('origin not allowed'));
    check('relay refuses loopback aliases and URL paths', (await Promise.all([
        originVerdict(`http://localhost:${relayPort}`, `localhost:${relayPort}`),
        originVerdict(`http://[::1]:${relayPort}`, `[::1]:${relayPort}`),
        originVerdict(`http://127.0.0.1:${relayPort}/relay`),
    ])).every((result) => result.body.includes('origin not allowed')));
    check('relay refuses a foreign origin', (await originVerdict('https://evil.example')).body.includes('origin not allowed'));

    const index = await get(relayBase, '/index.html');
    check('relay serves index.html as html', index.status === 200 && (contentType(index)).includes('text/html'));
    check('relay index.html revalidates', cacheControl(index) === 'no-store', cacheControl(index));
    const csp = index.headers.get('content-security-policy') || '';
    check('relay web carries strict CSP', csp.includes("default-src 'self'") && csp.includes('wasm-unsafe-eval'), csp.slice(0, 60));
    // The sandboxed same-origin preview frame must be embeddable; frames from any other origin stay blocked.
    check('relay web CSP frames only itself', csp.includes("frame-src 'self'") && csp.includes("frame-ancestors 'none'"), csp);
    check('relay web allows self camera/mic', (index.headers.get('permissions-policy') || '').includes('camera=(self)'), index.headers.get('permissions-policy'));

    const worker = await get(relayBase, '/sw.js');
    check('relay sw.js is javascript + no-store', worker.status === 200
        && (contentType(worker)).includes('text/javascript')
        && cacheControl(worker) === 'no-store');

    const manifest = await get(relayBase, '/manifest.webmanifest');
    check('relay manifest is manifest+json + no-store', manifest.status === 200
        && (contentType(manifest)).includes('application/manifest+json')
        && cacheControl(manifest) === 'no-store');

    const wasm = await get(relayBase, '/canvaskit.wasm');
    check('relay fixed-name wasm revalidates instead of immutable', wasm.status === 200
        && contentType(wasm) === 'application/wasm'
        && !(cacheControl(wasm)).includes('immutable')
        && (cacheControl(wasm)).includes('must-revalidate'), `${contentType(wasm)} / ${wasm.headers.get('cache-control')}`);

    const hashed = await get(relayBase, '/assets/app-a1b2c3d4e5.js');
    check('relay hashed asset is immutable', hashed.status === 200 && (cacheControl(hashed)).includes('immutable'));

    const spa = await get(relayBase, '/pair?pair=ABC');
    check('relay SPA fallback serves index for /pair', spa.status === 200 && spa.body.includes('assets/app-a1b2c3d4e5.js') && cacheControl(spa) === 'no-store');

    const api = await get(relayBase, '/v1/push/vapid-public');
    check('relay /v1/ is API passthrough, not HTML', api.status !== 200 || !(contentType(api)).includes('text/html'), `status ${api.status}`);

    // Same assertions against the static export server (local preview path).
    const staticPort = await freePort();
    children.push(spawn(process.execPath, ['scripts/diagnostics/application/serveWebExport.mjs'], {
        env: { ...process.env, MUXR_WEB_EXPORT_DIR: root, MUXR_WEB_PORT: String(staticPort) },
        stdio: ['ignore', 'ignore', 'inherit'],
    }));
    await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('static server did not come up')), 10_000);
        const probe = async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${staticPort}/index.html`);
                if (response.ok) {
                    clearTimeout(deadline);
                    resolve();
                } else {
                    setTimeout(() => void probe(), 150);
                }
            } catch {
                setTimeout(() => void probe(), 150);
            }
        };
        void probe();
    });
    const staticBase = `http://127.0.0.1:${staticPort}`;
    const staticWasm = await get(staticBase, '/canvaskit.wasm');
    check('serveWebExport wasm is application/wasm', staticWasm.status === 200 && contentType(staticWasm) === 'application/wasm', contentType(staticWasm));
    check('serveWebExport fixed-name wasm revalidates', staticWasm.status === 200 && !cacheControl(staticWasm).includes('immutable'), cacheControl(staticWasm));
    const staticEntry = await get(staticBase, '/sw.js');
    check('serveWebExport sw.js revalidates', staticEntry.status === 200 && cacheControl(staticEntry) === 'no-store');
} catch (cause) {
    check('web serving flow completed', false, cause instanceof Error ? cause.message : String(cause));
} finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else {
            child.once('exit', resolve);
            child.once('error', resolve);
        }
    })));
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
    process.stderr.write(`checkWebServing: ${failures.length} failing check(s)\n`);
    process.exit(1);
}
process.stdout.write('checkWebServing: live relay + static server delivery verified\n');
