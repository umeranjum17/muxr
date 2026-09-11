/**
 * Real-browser proof of two storage/isolation boundaries, in headless system
 * Chromium over CDP (no new dependencies; same shape as checkDemoFlow):
 *
 * 1. Wrapping-key initialization is atomic across tabs. Two tabs of one
 *    origin, each its own JS module realm, initialize the REAL
 *    `webSecureStore.ts` (bundled by esbuild) on one shared signal, with one
 *    tab's WebCrypto slowed so the old get-then-put interleaving is exactly
 *    the one that overwrote the key. Both tabs reload and both must decrypt
 *    both secrets.
 * 2. Preview isolation holds at the service-worker response, not at a
 *    button. The REAL `muxr-preview-sw.js` serves a fixture app: framed
 *    without any sandbox attribute it still runs in an opaque origin with no
 *    storage, no opener, no top navigation and no PWA-origin fetch; a direct
 *    top-level navigation to the same URL is refused; a popup opened from
 *    inside the frame never receives the app; the frame reloads normally.
 *
 * Skips with a note only when no system Chromium exists.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const chromium = ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((candidate) => existsSync(candidate));
if (chromium === undefined) {
    process.stdout.write('..  no system chromium — skipping browser security checks\n');
    process.exit(0);
}

const failures = [];
const check = (name, ok, detail = '') => {
    process.stdout.write(`${ok ? 'ok' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
    if (!ok) failures.push(name);
};
const freePort = () => new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- fixture origin ---------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'muxr-browser-security-'));
await build({
    entryPoints: [join(root, 'apps/mobile/sources/pairing/infrastructure/webSecureStore.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: join(scratch, 'store.js'),
    logLevel: 'silent',
});
const storeJs = readFileSync(join(scratch, 'store.js'), 'utf8');
rmSync(scratch, { recursive: true, force: true });
const swJs = readFileSync(join(root, 'apps/mobile/public/muxr-preview-sw.js'), 'utf8');

const PREVIEW_MARKER = 'MUXR_PREVIEW_FIXTURE_APP';
// The previewed "app": reports what authority it ended up with to whoever
// embedded it, and offers a popup on request.
const previewApp = `<!doctype html><title>fixture</title><p>${PREVIEW_MARKER}</p>
<script>
(async () => {
  const report = { marker: '${PREVIEW_MARKER}', origin: self.origin, opener: window.opener !== null };
  try { localStorage.setItem('x', '1'); report.storage = 'allowed'; } catch (e) { report.storage = e.name; }
  try { await new Promise((res, rej) => { const r = indexedDB.open('probe'); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); report.indexedDb = 'allowed'; } catch (e) { report.indexedDb = e.name; }
  try { void window.top.location.href; report.topRead = 'allowed'; } catch (e) { report.topRead = e.name; }
  try { const r = await fetch('/store-probe.txt'); report.originFetch = r.ok ? 'allowed' : 'status:' + r.status; } catch (e) { report.originFetch = e.name; }
  window.addEventListener('message', (event) => { if (event.data === 'popup') window.open(location.href, '_blank'); });
  (window.parent === window ? window : window.parent).postMessage(report, '*');
})();
</script>`;

// The owning page: registers the real worker and answers its bridge
// requests for one channel with the fixture app, then embeds it WITHOUT any
// sandbox attribute so only the response boundary is under test.
const ownerHtml = `<!doctype html><title>owner</title>
<script>
window.reports = [];
window.addEventListener('message', (event) => { if (event.data && event.data.marker) window.reports.push(event.data); });
const bus = new BroadcastChannel('muxr-preview');
bus.onmessage = (event) => {
  const m = event.data;
  if (!m || m.kind !== 'muxr-preview-request' || m.channel !== 'c1') return;
  const html = ${JSON.stringify(previewApp).replace(/<\/script>/g, '<\\/script>')};
  bus.postMessage({ kind: 'muxr-preview-response', id: m.id, status: 200,
    headers: [['content-type', 'text/html; charset=utf-8'], ['set-cookie', 'app=1'], ['content-security-policy', 'sandbox allow-same-origin allow-scripts']],
    body: new TextEncoder().encode(html) });
};
window.ready = (async () => {
  const registration = await navigator.serviceWorker.register('/muxr-preview-sw.js', { scope: '/muxr-preview/' });
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (worker.state !== 'activated') await new Promise((resolve) => worker.addEventListener('statechange', () => { if (worker.state === 'activated') resolve(); }));
  const frame = document.createElement('iframe');
  frame.id = 'preview';
  frame.src = '/muxr-preview/c1/';
  document.body.appendChild(frame);
  return 'ready';
})();
</script>`;

// The wrapping-key race page: one module realm per tab, a shared start
// signal, and an optional artificial WebCrypto delay so the losing order is
// the deterministic one.
const storeHtml = `<!doctype html><title>store</title>
<script type="module">
const params = new URL(location.href).searchParams;
const name = params.get('name');
const delayMs = Number(params.get('delay') ?? '0');
if (delayMs > 0) {
  const original = crypto.subtle.generateKey.bind(crypto.subtle);
  crypto.subtle.generateKey = async (...args) => { await new Promise((r) => setTimeout(r, delayMs)); return original(...args); };
}
const store = await import('/store.js?realm=' + name);
window.store = store;
window.result = new Promise((resolve) => {
  const start = new BroadcastChannel('muxr-race');
  start.onmessage = async (event) => {
    if (event.data !== 'go') return;
    try { await store.setWebSecret(name, 'secret-' + name); resolve('stored'); }
    catch (e) { resolve('failed: ' + e.message); }
  };
  // BroadcastChannel never echoes to its poster: run the starter locally too.
  window.go = () => { start.postMessage('go'); start.onmessage({ data: 'go' }); };
});
window.storeReady = true;
</script>`;

const port = await freePort();
const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (path === '/store.js') return send(200, 'text/javascript', storeJs);
    if (path === '/store.html') return send(200, 'text/html', storeHtml);
    if (path === '/owner.html') return send(200, 'text/html', ownerHtml);
    if (path === '/muxr-preview-sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'service-worker-allowed': '/muxr-preview/' }); return res.end(swJs); }
    if (path === '/store-probe.txt') return send(200, 'text/plain', 'origin-private');
    return send(404, 'text/plain', 'not found');
});
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${port}`;

// --- browser ----------------------------------------------------------------
const CDP_PORT = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'muxr-browser-security-profile-'));
const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });

async function cdp(url) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        for (const listener of listeners) listener(msg);
    });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); setTimeout(() => reject(new Error('ws open timeout')), 10000); });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const cur = ++id;
        const timer = setTimeout(() => { pending.delete(cur); reject(new Error(`cdp timeout ${method}`)); }, 30000);
        pending.set(cur, (msg) => { clearTimeout(timer); if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result ?? {}); });
        ws.send(JSON.stringify({ id: cur, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
    return { send, on: (listener) => listeners.add(listener), close: () => ws.close() };
}

const waitForHttp = async (url, label) => {
    for (let started = Date.now(); ; await sleep(200)) {
        try { if ((await fetch(url)).ok) return; } catch {}
        if (Date.now() - started > 15000) throw new Error(`${label} did not come up`);
    }
};
await waitForHttp(`${origin}/store.html`, 'fixture server');
await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 'cdp endpoint');
const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browserCdp = await cdp(version.webSocketDebuggerUrl);

/** A tab in the shared default context (same origin storage for every tab). */
async function tab(url) {
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId, flatten: true });
    await browserCdp.send('Page.enable', {}, sessionId);
    await browserCdp.send('Runtime.enable', {}, sessionId);
    const evaluate = async (expression, awaitPromise = true) => {
        const result = await browserCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
        if (result.exceptionDetails) throw new Error(`page js error: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
        return result.result?.value;
    };
    const navigate = async (to) => {
        await browserCdp.send('Page.navigate', { url: to }, sessionId);
        for (let started = Date.now(); ; await sleep(100)) {
            if ((await evaluate('document.readyState')) === 'complete') return;
            if (Date.now() - started > 20000) throw new Error(`navigation to ${to} did not complete`);
        }
    };
    const waitFor = async (label, expression, timeoutMs = 20000) => {
        for (let started = Date.now(); ; await sleep(150)) {
            const value = await evaluate(expression);
            if (value) return value;
            if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
        }
    };
    if (url !== undefined) await navigate(url);
    return { targetId, sessionId, evaluate, navigate, waitFor, close: () => browserCdp.send('Target.closeTarget', { targetId }) };
}

try {
    // ---- 1. concurrent wrapping-key initialization --------------------------
    const slow = await tab(`${origin}/store.html?name=slow&delay=600`);
    const fast = await tab(`${origin}/store.html?name=fast`);
    await slow.waitFor('slow realm', 'window.storeReady === true');
    await fast.waitFor('fast realm', 'window.storeReady === true');
    await slow.evaluate('window.go()');
    const [slowResult, fastResult] = await Promise.all([slow.evaluate('window.result'), fast.evaluate('window.result')]);
    check('both tabs stored a secret concurrently', slowResult === 'stored' && fastResult === 'stored', `${slowResult} / ${fastResult}`);
    // Fresh realms after reload: nothing survives but IndexedDB.
    await slow.navigate(`${origin}/store.html?name=slow2`);
    await fast.navigate(`${origin}/store.html?name=fast2`);
    await slow.waitFor('slow realm reload', 'window.storeReady === true');
    await fast.waitFor('fast realm reload', 'window.storeReady === true');
    const readBoth = `Promise.all([window.store.getWebSecret('slow'), window.store.getWebSecret('fast')]).then((v) => JSON.stringify(v), (e) => 'error: ' + e.name)`;
    const fromSlow = await slow.evaluate(readBoth);
    const fromFast = await fast.evaluate(readBoth);
    check('every tab decrypts both secrets with the one persisted key', fromSlow === '["secret-slow","secret-fast"]' && fromFast === '["secret-slow","secret-fast"]', `${fromSlow} / ${fromFast}`);
    await slow.close();
    await fast.close();

    // ---- 2. preview isolation at the worker response ------------------------
    const owner = await tab(`${origin}/owner.html`);
    const ready = await owner.evaluate(`window.ready.catch((e) => 'failed: ' + e.message)`);
    check('preview worker registers and the frame is embedded', ready === 'ready', String(ready));
    const report = JSON.parse(await owner.waitFor('framed fixture report', 'window.reports.length > 0 ? JSON.stringify(window.reports[0]) : ""'));
    check('framed preview renders through the worker', report.marker === PREVIEW_MARKER);
    check('framed preview is an opaque origin even without an iframe sandbox attribute', report.origin === 'null', String(report.origin));
    check('framed preview has no PWA-origin localStorage', report.storage === 'SecurityError', String(report.storage));
    check('framed preview has no PWA-origin IndexedDB', report.indexedDb !== 'allowed', String(report.indexedDb));
    check('framed preview cannot read its top-level opener', report.topRead === 'SecurityError', String(report.topRead));
    check('framed preview cannot fetch PWA-origin resources', report.originFetch !== 'allowed', String(report.originFetch));
    check('framed preview has no opener', report.opener === false);
    // Reload keeps working.
    await owner.evaluate(`window.reports = []; document.getElementById('preview').contentWindow.location.reload()`, false).catch(() => undefined);
    await owner.evaluate(`document.getElementById('preview').src = '/muxr-preview/c1/?reload=1'`);
    const reloaded = JSON.parse(await owner.waitFor('reloaded fixture report', 'window.reports.length > 0 ? JSON.stringify(window.reports[0]) : ""'));
    check('framed preview reloads normally', reloaded.marker === PREVIEW_MARKER && reloaded.origin === 'null');

    // A popup from inside the frame never receives the app as a first-class page.
    const popups = [];
    browserCdp.on((msg) => { if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.type === 'page') popups.push(msg.params.targetInfo); });
    await browserCdp.send('Target.setDiscoverTargets', { discover: true });
    const before = popups.length;
    await owner.evaluate(`document.getElementById('preview').contentWindow.postMessage('popup', '*')`);
    await sleep(1500);
    let popupText = 'no popup opened';
    const popup = popups.slice(before).find((info) => info.url.includes('/muxr-preview/'));
    if (popup !== undefined) {
        const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
        await browserCdp.send('Runtime.enable', {}, sessionId);
        await sleep(500);
        const value = await browserCdp.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, sessionId).catch(() => ({}));
        popupText = String(value.result?.value ?? '');
        await browserCdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => undefined);
    }
    check('a popup opened from the preview never gets the app top-level', !popupText.includes(PREVIEW_MARKER), popupText.slice(0, 80));

    // Direct top-level navigation is refused by the worker while the owner stays open.
    const direct = await tab(`${origin}/muxr-preview/c1/`);
    const directText = await direct.evaluate('document.body.innerText');
    const directOrigin = await direct.evaluate('self.origin');
    check('direct top-level navigation is refused', !directText.includes(PREVIEW_MARKER) && directText.includes('only opens inside muxr'), directText.slice(0, 80));
    check('the refusal page itself has no origin authority', directOrigin === 'null', String(directOrigin));
    await direct.close();
    await owner.close();
} catch (error) {
    check('browser security flow completes', false, error instanceof Error ? error.message : String(error));
} finally {
    browserCdp.close();
    browser.kill();
    await new Promise((resolve) => browser.once('exit', resolve));
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (failures.length > 0) {
    process.stderr.write(`FAIL browser security: ${failures.join('; ')}\n`);
    process.exit(1);
}
process.stdout.write('browser security: concurrent wrapping key and preview response isolation hold\n');
