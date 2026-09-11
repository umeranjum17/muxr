/**
 * Demo replay browser flow: serves the REAL production export and drives the
 * REAL /demo route in headless Chromium over CDP. No new dependencies:
 * system Chromium, the existing static server, the Node 22 global WebSocket,
 * and polling waits (no fixed-sleep races).
 *
 * Phase A — full loop on the first tab: production herd → blocked agent →
 * real session terminal → real composer send → working → done → Inbox
 * reconciles, with a real hidden→visible cycle up front.
 * Phase B — direct fresh load in a new browser context (no shared state, no
 * clicks, no focus tricks): the herd must bootstrap deterministically, not
 * via a focus effect. This mirrors the harness that caught the bootstrap
 * race.
 *
 * Page console errors and uncaught exceptions fail the run in both phases.
 * Skipped with a note when apps/mobile/dist is absent (CI exports first) or
 * no system Chromium exists.
 */
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dist = join(root, 'apps', 'mobile', 'dist');

const failures = [];
const check = (name, ok, detail = '') => {
    const mark = ok ? 'ok' : 'FAIL';
    const suffix = detail === '' ? '' : ` — ${detail}`;
    process.stdout.write(`${mark}  ${name}${suffix}\n`);
    if (!ok) failures.push(name);
};

if (!existsSync(join(dist, 'index.html'))) {
    process.stdout.write('..  dist export absent — skipping demo browser flow (CI exports first)\n');
    process.exit(0);
}

const chromium = ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((candidate) => existsSync(candidate));
if (chromium === undefined) {
    process.stdout.write('..  no system chromium — skipping demo browser flow\n');
    process.exit(0);
}

const freePort = () => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
    });
});
const port = await freePort();
const CDP_PORT = await freePort();

const serve = spawn(process.execPath, ['scripts/diagnostics/application/serveWebExport.mjs'], {
    cwd: root,
    env: { ...process.env, MUXR_WEB_EXPORT_DIR: dist, MUXR_WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
});
// Test browser only: software rasterizer off denies WebGL contexts, so the
// production TerminalView falls back to its canvas renderer whose pixels
// headless capture can read. Production keeps WebGL; nothing in the app
// changes for this flag.
const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', `--remote-debugging-port=${CDP_PORT}`, 'about:blank'], {
    stdio: ['ignore', 'pipe', 'pipe'],
});

const killAll = async () => {
    serve.kill();
    browser.kill();
    await Promise.all([
        new Promise((resolve) => serve.once('exit', resolve)),
        new Promise((resolve) => browser.once('exit', resolve)),
    ]);
};

/** CDP driver for one page target; collects page errors for the whole phase. */
async function drive(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(String(event.data));
            if (msg.id !== undefined && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            } else if (msg.method === 'Runtime.exceptionThrown') {
                pageErrors.push(`exception: ${JSON.stringify(msg.params?.exceptionDetails?.text ?? msg.params?.exceptionDetails).slice(0, 300)}`);
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
                const text = (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 300);
                pageErrors.push(`console.error: ${text}`);
            }
        } catch {}
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const cur = ++id;
        const timer = setTimeout(() => { pending.delete(cur); reject(new Error(`cdp timeout ${method}`)); }, 20000);
        pending.set(cur, (msg) => { clearTimeout(timer); resolve(msg); });
        ws.send(JSON.stringify({ id: cur, method, params }));
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        setTimeout(() => reject(new Error('ws open timeout')), 10000);
    });
    await send('Page.enable');
    await send('Runtime.enable');
    const evaluate = async (expression) => {
        const res = await send('Runtime.evaluate', { expression, returnByValue: true });
        if (res.result?.exceptionDetails) throw new Error(`page js error: ${JSON.stringify(res.result.exceptionDetails).slice(0, 200)}`);
        return res.result?.result?.value;
    };
    const bodyText = () => evaluate('document.body.innerText');
    const waitFor = async (label, predicate, timeoutMs = 45000) => {
        const started = Date.now();
        for (;;) {
            const text = await bodyText();
            if (predicate(text)) return text;
            if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
            await new Promise((r) => setTimeout(r, 500));
        }
    };
    const hideAndShow = async () => {
        try {
            await send('Page.setWebLifecycleState', { state: 'hidden' });
            await new Promise((r) => setTimeout(r, 2000));
            await send('Page.setWebLifecycleState', { state: 'active' });
        } catch {
            await evaluate(`(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
                document.dispatchEvent(new Event('visibilitychange'));
            })()`);
            await new Promise((r) => setTimeout(r, 2000));
            await evaluate(`(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                document.dispatchEvent(new Event('visibilitychange'));
                window.dispatchEvent(new Event('pageshow'));
            })()`);
        }
    };
    const close = () => ws.close();
    return { send, evaluate, bodyText, waitFor, hideAndShow, pageErrors, close };
}

try {
    const waitForHttp = async (url, label, timeoutMs) => {
        const started = Date.now();
        for (;;) {
            try {
                const response = await fetch(url);
                if (response.ok) return;
            } catch {}
            if (Date.now() - started > timeoutMs) throw new Error(`${label} did not come up`);
            await new Promise((r) => setTimeout(r, 200));
        }
    };
    await waitForHttp(`http://127.0.0.1:${port}/index.html`, 'static server', 10000);
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 'cdp endpoint', 15000);

    // Phase A: full interactive loop on the first tab.
    const firstTabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const firstPage = firstTabs.find((tab) => tab.type === 'page');
    if (!firstPage) throw new Error('no page target');
    const journey = await drive(firstPage);
    await journey.send('Page.navigate', { url: `http://127.0.0.1:${port}/demo` });
    // Real hidden→visible transition BEFORE asserting the herd: the demo
    // must not perform a socket visibility reconnect (tearing down the
    // deterministic transport used to brick the herd until reload), and the
    // transport must survive close/reopen regardless.
    await journey.hideAndShow();
    const herdText = await journey.waitFor('herd', (text) => text.includes('Rebase release branch onto main'));
    check('demo shows the working agent', herdText.includes('Migrate billing to usage-based plans'));
    check('demo shows the blocked agent', herdText.includes('Rebase release branch onto main') && herdText.includes('Needs you'));
    check('demo shows the done agent', herdText.includes('Add retry with backoff to sync'));
    check('demo shows inbox attention', herdText.includes('Needs you'));
    check('demo bar says nothing is real', herdText.includes('nothing is real') && !/deterministic|backend/i.test(herdText));
    check('demo never shows the unpaired pairing root', !herdText.includes('Enter pairing string'));
    check('demo boots without init errors', !herdText.includes('Error initializing'));

    // Open the blocked agent's real session terminal with one bubbled click.
    await journey.evaluate(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Rebase release branch onto main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    // innerText carries visible labels only (^C, not the Control C
    // accessibility label; placeholders never appear) — assert those, and
    // the composer input via the DOM directly.
    const sessionText = await journey.waitFor('session', (text) => text.includes('Rebase release branch onto main') && text.includes('^C'));
    check('blocked row opens the real session', sessionText.includes('Rebase release branch onto main'));
    check('real keys row renders from the plugin manifest', sessionText.includes('^C') && sessionText.includes('esc'));
    const composerPresent = await (async () => {
        const started = Date.now();
        for (;;) {
            const present = await journey.evaluate(`!![...document.querySelectorAll('input[placeholder="Type a prompt…"]')].some((el) => el.offsetParent !== null)`);
            if (present === true) return true;
            if (Date.now() - started > 30000) return present;
            await new Promise((r) => setTimeout(r, 500));
        }
    })();
    check('real composer is live', composerPresent === true);
    check('no install prompt on the demo route', !sessionText.includes('Install the app'));

    // Approve through the real composer (native setter so React sees it).
    // The composer can remount as the terminal attaches, so find-set-click
    // retries as one unit instead of assuming a stable node. HomeDock mounts
    // under pushed session routes, so the selectors take the visible
    // composer — the one a user and assistive tech actually reach.
    const visibleComposer = `[...document.querySelectorAll('input[placeholder="Type a prompt…"]')].find((el) => el.offsetParent !== null) ?? document.querySelector('input[placeholder="Type a prompt…"]')`;
    const visibleSend = `[...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send' && el.offsetParent !== null) ?? [...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send')`;
    await (async () => {
        const started = Date.now();
        for (;;) {
            const sent = await journey.evaluate(`(() => {
                const box = ${visibleComposer};
                if (!box) return 'missing';
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, 'approved, push it');
                box.dispatchEvent(new Event('input', { bubbles: true }));
                const sendButton = ${visibleSend};
                if (!sendButton || sendButton.getAttribute('aria-disabled') === 'true') return 'not-ready';
                sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 'sent';
            })()`);
            if (sent === 'sent') return;
            if (Date.now() - started > 30000) throw new Error(`composer never became sendable (last: ${sent})`);
            await new Promise((r) => setTimeout(r, 500));
        }
    })();
    // Fixture completion: the scripted continuation lands ~2s after send,
    // but the session terminal paints to canvas (invisible to innerText),
    // so wait out the deterministic timeline with margin rather than
    // polling for pixels a human sees but the DOM never carries.
    await new Promise((r) => setTimeout(r, 8000));
    // Back through the real accessible control, not history.back(): only
    // the real control exercises the navigation blur/focus path the
    // tree-pane refresh depends on.
    await journey.evaluate(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && (el.getAttribute('aria-label') === 'Back' || el.getAttribute('aria-label') === 'Go back'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const reconciled = await journey.waitFor(
        'reconciliation',
        (text) => text.includes('in sync with main') && !text.includes('Needs you'),
        30000,
    );
    check('approval visibly continues the agent', reconciled.includes('in sync with main'));
    // Bex-specific: every Bex card segment must read Done — the already-done
    // third card also says Done, so a generic check would pass on a stale
    // blocked card. Spaces rows carry no status word and are exempt.
    const bexSegments = [];
    {
        let from = -1;
        for (;;) {
            const at = reconciled.indexOf('Rebase release branch onto main', from + 1);
            if (at === -1) break;
            bexSegments.push(reconciled.slice(at, at + 120));
            from = at;
        }
    }
    check('blocked card reconciles to Done', bexSegments.length > 0 && bexSegments.some((segment) => segment.includes('Done')), `${bexSegments.length} Bex segments`);
    check('no Bex card keeps Needs you', !bexSegments.some((segment) => segment.includes('Needs you')));
    check('agent reaches done', reconciled.includes('Done'));
    check('inbox reconciles after done', !reconciled.includes('Needs you'));

    // Artifact journey on the done agent, through the shipped code-plugin
    // contribution and the production file/diff view — no custom artifact
    // component, no DemoBar shortcut.
    const clickText = async (text) => journey.evaluate(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === ${JSON.stringify(text)})?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const clickControl = async (label) => journey.evaluate(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === ${JSON.stringify(label)})?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const shadowText = () => journey.evaluate(`(() => {
        const host = document.querySelector('diffs-container');
        if (!host || !host.shadowRoot) return null;
        return host.shadowRoot.textContent || '';
    })()`);
    await clickText('Add retry with backoff to sync');
    await journey.waitFor('done session', (text) => text.includes('Add retry with backoff to sync') && text.includes('^C'));
    await clickControl('Session actions');
    // The row's visible text is the title; the accessibility label is not
    // part of innerText. The menu itself is proven by its Stop agent row.
    await journey.waitFor('changes control', (text) => text.includes('Stop agent') && text.includes('Changes'));
    // The open menu owns one history entry: browser Back closes it and stays
    // on the session; Escape does the same.
    await journey.evaluate('window.history.back()');
    await journey.waitFor('menu closed by back', (text) => !text.includes('Stop agent'));
    check('browser back closes the session menu without leaving', (await journey.evaluate('window.location.pathname')).startsWith('/session/'));
    await clickControl('Session actions');
    await journey.waitFor('menu reopened', (text) => text.includes('Stop agent'));
    // Dispatched at the body like a real key press (window-targeted events
    // skip the capture phase the sheet relies on).
    await journey.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await journey.waitFor('menu closed by escape', (text) => !text.includes('Stop agent'));
    check('escape closes the session menu and stays', (await journey.evaluate('window.location.pathname')).startsWith('/session/'));
    // The entry an Escape-closed menu leaves behind must not cost a press.
    await journey.evaluate('window.history.back()');
    await journey.waitFor('one back leaves the session', (text) => text.includes('nothing is real') && text.includes('Add retry with backoff to sync'));
    check('one back after escape leaves the session', (await journey.evaluate('window.location.pathname')) === '/demo');
    await clickText('Add retry with backoff to sync');
    await journey.waitFor('done session again', (text) => text.includes('Add retry with backoff to sync') && text.includes('^C'));
    await clickControl('Session actions');
    await journey.waitFor('menu open again', (text) => text.includes('Stop agent') && text.includes('Changes'));
    await clickControl('Open changed files');
    await journey.waitFor('changed file', (text) => text.includes('sync.ts'));
    await clickText('sync.ts');
    // Pierre renders into shadow DOM (invisible to innerText): pierce it.
    // The deterministic diff lands with the file content; poll both.
    const diffVisible = await (async () => {
        const started = Date.now();
        for (;;) {
            const shadow = await shadowText();
            if (typeof shadow === 'string' && shadow.includes('resetReconnectBackoff')) return shadow;
            if (Date.now() - started > 30000) return shadow;
            await new Promise((r) => setTimeout(r, 500));
        }
    })();
    check('production file view renders the recorded artifact', typeof diffVisible === 'string' && diffVisible.includes('resetReconnectBackoff'));
    check('production diff view renders the recorded patch', typeof diffVisible === 'string' && diffVisible.includes('connect(): void'));
    // Back correctly: file → session → herd, through the real controls.
    await clickControl('Back');
    await journey.waitFor('back to session', (text) => text.includes('^C'));
    check('back from file lands on the session', (await journey.evaluate('window.location.pathname')).startsWith('/session/'));
    await clickControl('Back');
    const herdAgain = await journey.waitFor('back to herd', (text) => text.includes('nothing is real') && text.includes('Add retry with backoff to sync'));
    check('back from session lands on the herd', herdAgain.includes('Migrate billing to usage-based plans'));
    // Restart restores the whole journey: Bex blocked again, replay intact.
    await clickControl('Restart the demo');
    const restarted = await journey.waitFor('restart', (text) => text.includes('Needs you'), 30000);
    check('restart restores the blocked agent', restarted.includes('Needs you'));
    check('no page errors during the journey', journey.pageErrors.length === 0, journey.pageErrors.slice(0, 3).join(' | '));
    journey.close();

    // Phase B: direct fresh load in a new browser context — no shared
    // storage, no clicks, no focus choreography. The herd must bootstrap
    // deterministically through the explicit route bootstrap, never via a
    // focus effect.
    const browserVersion = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const browserWs = new WebSocket(browserVersion.webSocketDebuggerUrl);
    let browserId = 0;
    const browserPending = new Map();
    const parityErrors = [];
    let paritySessionId = null;
    browserWs.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(String(event.data));
            if (msg.id !== undefined && browserPending.has(msg.id)) {
                browserPending.get(msg.id)(msg);
                browserPending.delete(msg.id);
            } else if (msg.sessionId !== undefined && msg.sessionId === paritySessionId) {
                if (msg.method === 'Runtime.exceptionThrown') {
                    parityErrors.push(`exception: ${JSON.stringify(msg.params?.exceptionDetails?.text ?? msg.params?.exceptionDetails).slice(0, 300)}`);
                } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
                    const text = (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 300);
                    parityErrors.push(`console.error: ${text}`);
                }
            }
        } catch {}
    });
    const browserSend = (method, params = {}) => new Promise((resolve, reject) => {
        const cur = ++browserId;
        const timer = setTimeout(() => { browserPending.delete(cur); reject(new Error(`cdp timeout ${method}`)); }, 20000);
        browserPending.set(cur, (msg) => { clearTimeout(timer); resolve(msg); });
        browserWs.send(JSON.stringify({ id: cur, method, params }));
    });
    await new Promise((resolve, reject) => {
        browserWs.addEventListener('open', () => resolve(), { once: true });
        setTimeout(() => reject(new Error('browser ws open timeout')), 10000);
    });
    const contextCreated = await browserSend('Target.createBrowserContext');
    const contextId = contextCreated.result?.browserContextId;
    if (!contextId) throw new Error('fresh browser context unavailable');
    const freshTarget = await browserSend('Target.createTarget', {
        url: 'about:blank',
        browserContextId: contextId,
    });
    const freshTargetId = freshTarget.result?.targetId;
    if (!freshTargetId) throw new Error('fresh target unavailable');
    const attach = await browserSend('Target.attachToTarget', { targetId: freshTargetId, flatten: true });
    const sessionId = attach.result?.sessionId;
    if (!sessionId) throw new Error('fresh target attach unavailable');
    const freshTabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const freshPage = freshTabs.find((tab) => tab.id === freshTargetId || tab.targetId === freshTargetId);
    if (!freshPage?.webSocketDebuggerUrl) throw new Error('fresh page target unavailable');
    // NOTE: browserWs stays open — Phase C reuses it for the parity target.
    const fresh = await drive(freshPage);
    await fresh.send('Page.navigate', { url: `http://127.0.0.1:${port}/demo` });
    await fresh.hideAndShow();
    const freshHerd = await fresh.waitFor(
        'fresh herd',
        (text) => text.includes('Rebase release branch onto main') && text.includes('connected') && !text.includes('Reconnecting'),
        45000,
    );
    check('fresh load bootstraps the herd without focus tricks', freshHerd.includes('Migrate billing to usage-based plans'));
    check('fresh load shows inbox attention', freshHerd.includes('Needs you'));
    check('fresh load never shows the pairing root', !freshHerd.includes('Enter pairing string'));
    check('no page errors on fresh load', fresh.pageErrors.length === 0, fresh.pageErrors.slice(0, 3).join(' | '));

    // /pair with no link is a neutral manual form: no alert role, no backticks.
    await fresh.send('Page.navigate', { url: `http://127.0.0.1:${port}/pair` });
    const pairText = await fresh.waitFor('pair first paint', (text) => text.includes('Pairing string') || text.includes('pairing'));
    check('pair first paint has no alert', !(await fresh.evaluate(`!!document.querySelector('[role="alert"]')`)));
    check('pair first paint has no backticks', !pairText.includes('`'));
    check('pair first paint names the command in a chip', pairText.includes('muxr pair --browser'));
    fresh.close();

    // Phase C: compact parity — the phone composition at phone widths, the
    // split desktop at desktop widths. Same production export, dark scheme
    // like the native reference, screenshots to the pane attachments dir.
    const attachmentsDir = process.env.HERDR_PANE_ID
        ? `/home/umer/.muxr/attachments/pane/${process.env.HERDR_PANE_ID}`
        : null;
    const { mkdirSync, writeFileSync } = await import('node:fs');
    if (attachmentsDir) mkdirSync(attachmentsDir, { recursive: true });
    const parityTarget = await browserSend('Target.createTarget', {
        url: 'about:blank',
        browserContextId: contextId,
    });
    const parityTargetId = parityTarget.result?.targetId;
    if (!parityTargetId) throw new Error('parity target unavailable');
    const parityAttach = await browserSend('Target.attachToTarget', { targetId: parityTargetId, flatten: true });
    paritySessionId = parityAttach.result?.sessionId;
    if (!paritySessionId) throw new Error('parity attach unavailable');
    const paritySend = (method, params = {}) => new Promise((resolve, reject) => {
        const cur = ++browserId;
        const timer = setTimeout(() => { browserPending.delete(cur); reject(new Error(`cdp timeout ${method}`)); }, 20000);
        browserPending.set(cur, (msg) => { clearTimeout(timer); resolve(msg); });
        browserWs.send(JSON.stringify({ id: cur, method, params, sessionId: paritySessionId }));
    });
    const parityEval = async (expression) => {
        const res = await paritySend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (res.result?.exceptionDetails) throw new Error(`parity js error: ${JSON.stringify(res.result.exceptionDetails).slice(0, 200)}`);
        return res.result?.result?.value;
    };
    await paritySend('Runtime.enable');
    // The website's demo QA measures these on the exported DOM: every
    // visible <img> carries alt, no visible text under 11px, every control's
    // own box (hitSlop is invisible to the DOM) is at least 44px.
    const craftAudit = () => parityEval(`(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
        const name = (el) => el.tagName + '[' + (el.getAttribute('aria-label') || (el.innerText || '').trim().slice(0, 24)) + ']';
        const imgs = [...document.querySelectorAll('img')].filter((el) => vis(el) && !el.hasAttribute('alt')).map((el) => el.src.split('/').pop().slice(0, 30));
        const small = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) { const n = walker.currentNode; if (!n.textContent.trim()) continue; const el = n.parentElement; if (!el || !vis(el)) continue; const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 11) small.push(fs + 'px ' + name(el)); }
        const targets = [...document.querySelectorAll('button,a[href],[role="button"],[role="tab"],[role="link"],input,textarea,[role="switch"]')].filter((el) => vis(el) && !el.classList.contains('xterm-helper-textarea')).map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), d: name(el) }; }).filter((t) => t.w < 44 || t.h < 44).map((t) => t.d + ' ' + t.w + 'x' + t.h);
        return JSON.stringify({ imgs, small, targets });
    })()`);
    const checkCraft = async (label) => {
        const audit = JSON.parse(await craftAudit());
        check(`${label}: every visible image has alt`, audit.imgs.length === 0, audit.imgs.join(', '));
        check(`${label}: no visible text under 11px`, audit.small.length === 0, audit.small.slice(0, 5).join(', '));
        check(`${label}: every control box is at least 44px`, audit.targets.length === 0, audit.targets.slice(0, 8).join(', '));
    };
    const parityShot = async (name, width, height, path, scheme = 'dark') => {
        await paritySend('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 900 });
        await paritySend('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await paritySend('Page.navigate', { url: `http://127.0.0.1:${port}${path}` });
        await new Promise((r) => setTimeout(r, 9000));
        const shot = await paritySend('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
        if (attachmentsDir) {
            writeFileSync(`${attachmentsDir}/${name}.jpg`, Buffer.from(shot.result.data, 'base64'));
            process.stdout.write(`shot ${attachmentsDir}/${name}.jpg\n`);
        }
        return shot;
    };
    const parityText = () => parityEval('document.body.innerText');
    const parityWaitFor = async (label, predicate, timeoutMs = 45000) => {
        const started = Date.now();
        for (;;) {
            const text = await parityText();
            if (predicate(text)) return text;
            if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
            await new Promise((r) => setTimeout(r, 500));
        }
    };
    // parityWaitFor only polls text: state predicates need their own poller.
    // (An async predicate is always truthy and would pass vacuously.)
    const parityWaitForState = async (label, poll, timeoutMs = 20000) => {
        const started = Date.now();
        for (;;) {
            const value = await poll();
            if (value) return value;
            if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
            await new Promise((r) => setTimeout(r, 400));
        }
    };
    const noOverflow = () => parityEval('document.documentElement.scrollWidth <= window.innerWidth + 1');
    // The collapsed dock entry renders placeholder text (not an input); the
    // focused composer renders the real textarea.
    // Test-id entry handle: placeholder text hides once a draft exists.
    const dockEntryPresent = () => parityEval(`!!document.querySelector('[data-testid="home-dock-entry"]')`);
    const clickDockEntry = () => parityEval(`document.querySelector('[data-testid="home-dock-entry"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    // A card past the strip's preview pause window only polls pane.read
    // once swiped into view: keep swiping until its thumbnail carries the
    // expected transcript line (the card itself may still be mounting).
    const waitThumbnailLine = async (label, cardTitle, needle, timeoutMs = 30000) => {
        const started = Date.now();
        for (;;) {
            // The card title renders in both the session list and the live
            // strip (DOM order varies by density): swipe every match so the
            // strip card unpauses its pane.read thumbnail regardless.
            await parityEval(`[...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.innerText === ${JSON.stringify(cardTitle)}).forEach((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }))`);
            const text = await parityText();
            if (text.includes(needle)) return text;
            if (Date.now() - started > timeoutMs) {
                throw new Error(`timed out waiting for ${label}`);
            }
            await new Promise((r) => setTimeout(r, 800));
        }
    };
    const parityClickText = (text) => parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === ${JSON.stringify(text)})?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const parityClickLabel = (label) => parityEval(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === ${JSON.stringify(label)})?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const pathname = () => parityEval('window.location.pathname');
    const waitPath = async (prefix, timeoutMs = 20000) => {
        const started = Date.now();
        for (;;) {
            const path = await pathname();
            if (path.startsWith(prefix)) return path;
            if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for route ${prefix} (at ${path})`);
            await new Promise((r) => setTimeout(r, 500));
        }
    };
    const testid = (id) => parityEval(`!!document.querySelector('[data-testid="${id}"]')`);
    const pressKey = async (key, code, keyCode) => {
        await paritySend('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
        await paritySend('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    };
    const activeElementLabel = () => parityEval(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'body';
        return el.getAttribute && (el.getAttribute('aria-label') || el.innerText || el.tagName) || el.tagName;
    })()`);

    // 390: native phone composition, no tab bar, no primary +.
    await parityShot('parity-390-demo', 390, 844, '/demo');
    // The shell is the loading state: no full-screen spinner ever mounts on
    // the demo route, only the hairline under the header.
    check('demo route shows no full-screen spinner', !await parityEval(`!!document.querySelector('[role="progressbar"]:not([aria-label="Loading"])')`));
    await checkCraft('390 demo');
    // A refused clipboard never reads as Copied: the exact install command is
    // shown to select instead.
    await parityEval(`(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); document.execCommand = () => { throw new Error('denied'); }; })()`);
    await parityEval(`[...document.querySelectorAll('[aria-label]')].find((el) => (el.getAttribute('aria-label') || '').startsWith('Connect your computer'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const afterCopy = await parityWaitFor('copy fallback', (text) => text.includes('@trymuxr/cli'), 10000);
    check('denied clipboard shows the install command instead of Copied', afterCopy.includes('npm install -g --ignore-scripts @trymuxr/cli@latest') && !afterCopy.includes('Copied'));
    // Mermaid is served on demand from public/, never from the entry: the
    // real loader runs here and renders a diagram in the exported page.
    const mermaidResult = await parityEval(`(async () => {
        const html = await (await fetch('/')).text();
        const scripts = [...html.matchAll(/src="(\\/_expo\\/static\\/js\\/web\\/index-[^"]+)"/g)];
        if (scripts.length === 0) return 'no-index';
        const index = await (await fetch(scripts[0][1])).text();
        if (index.includes('__esbuild_esm_mermaid_nm')) return 'mermaid-in-entry';
        await new Promise((resolve, reject) => { const tag = document.createElement('script'); tag.src = '/mermaid.min.js'; tag.onload = resolve; tag.onerror = () => reject(new Error('script failed')); document.head.appendChild(tag); });
        const mermaid = globalThis.mermaid;
        if (!mermaid || !mermaid.render) return 'no-global';
        mermaid.initialize({ startOnLoad: false, theme: 'dark' });
        const { svg } = await mermaid.render('muxr-check', 'graph TD; a-->b');
        return svg.includes('<svg') ? 'rendered' : 'no-svg';
    })().catch((error) => 'error: ' + (error && error.message))`);
    check('mermaid loads on demand and renders a diagram', mermaidResult === 'rendered', String(mermaidResult));
    const herd390 = await parityWaitFor('compact herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('compact herd renders dark phone composition', herd390.includes('WHILE YOU WERE AWAY') && herd390.includes('SPACES'));
    check('compact has no bottom tab bar', !await parityEval('!!document.querySelector(\'[role="tablist"], [role="tab"]\')'));
    check('compact search and settings controls present', await parityEval(`!![...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Search')`) && await parityEval(`!![...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Settings')`));
    check('compact has no primary new-agent plus', !await parityEval(`!![...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'New agent')`));
    check('compact HomeDock entry present', await dockEntryPresent());
    check('compact dock entry is named', await parityEval(`!![...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Start an agent')`));
    check('compact has no horizontal overflow', await noOverflow());
    check('compact nav row exposes production chips', await testid('phone-nav-row')
        && herd390.includes('Machine') && herd390.includes('Usage') && herd390.includes('Inbox') && herd390.includes('Files') && herd390.includes('Ports'));
    check('compact thumbnails carry no raw ANSI', !herd390.includes('\x1b'));
    check('compact inbox badge counts attention', herd390.includes('Needs you'));

    // Chips navigate through the real plugin routes and back.
    const chipJourneys = [
        { chip: 'Usage', marker: 'Tokens' },
        { chip: 'Inbox', marker: 'Needs approval' },
        { chip: 'Files', marker: 'Repositories' },
        { chip: 'Ports', marker: 'Nothing listening' },
    ];
    for (const journey of chipJourneys) {
        await parityClickText(journey.chip);
        await waitPath('/plugin');
        const content = await parityWaitFor(`${journey.chip} content`, (text) => text.includes(journey.marker), 20000);
        check(`${journey.chip} chip opens its plugin destination`, content.includes(journey.marker));
        await parityEval('window.history.back()');
        await parityWaitFor('back to herd', (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES'));
    }
    check('browser back leaves every plugin destination', (await pathname()) === '/demo');
    // Inbox rows carry the agent mark and a state word, never a letter tile.
    await parityClickText('Inbox');
    await waitPath('/plugin');
    await parityWaitFor('inbox content', (text) => text.includes('Needs approval'), 20000);
    check('inbox rows render agent glyph images', await parityEval(`document.querySelectorAll('img').length >= 3`));
    check('inbox rows announce a state word', await parityEval(`[...document.querySelectorAll('[aria-label]')].some((el) => /Needs you$/.test(el.getAttribute('aria-label')))`));
    await parityEval('window.history.back()');
    await parityWaitFor('back to herd', (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES'));
    check('demo journey shows no raw RPC text', !/unsupported in demo replay|machine\.|plugin\.|rpc/i.test(await parityText()));
    check('herd exposes headings', await parityEval(`document.querySelectorAll('[role="heading"]').length >= 1`));

    // Focus reveals the progressive config; a typed prompt sends. The rows
    // show icon + value (labels live in accessibility names, as on native).
    await clickDockEntry();
    const focusText = await parityWaitFor('focus config', (text) => text.includes('No worktree') && text.includes('Start '));
    check('focus reveals agent/project/worktree config', focusText.includes('No worktree') && focusText.includes('Start '));
    check('focus composer is marked', await testid('focus-composer'));

    // Browser back with focus open closes the modal without leaving the route.
    await parityEval('window.history.back()');
    await parityWaitFor('focus closed by history', (text) => !text.includes('No worktree'), 15000);
    check('history back closes focus mode on the herd', (await pathname()) === '/demo');

    // Gear menu keyboard journey: initial focus, arrows, select, restore.
    await clickDockEntry();
    await parityWaitFor('refocus config', (text) => text.includes('No worktree'));
    await parityClickLabel('Composer options');
    await parityWaitFor('menu opens', (text) => text.includes('Shell'));
    check('menu opens with focus on an option', await parityWaitForState('menu initial focus', async () => (
        await parityEval(`(() => { const el = document.activeElement; return el && el.getAttribute && el.getAttribute('role'); })()`)
    )) === 'radio');
    const optionBefore = await parityEval(`(document.activeElement && document.activeElement.innerText || '').slice(0, 40)`);
    await pressKey('ArrowDown', 'ArrowDown', 40);
    await new Promise((r) => setTimeout(r, 800));
    const optionAfter = await parityEval(`(document.activeElement && document.activeElement.innerText || '').slice(0, 40)`);
    check('arrow keys move within the menu', optionBefore !== '' && optionAfter !== '' && optionBefore !== optionAfter, `${optionBefore} -> ${optionAfter}`);
    await pressKey('Enter', 'Enter', 13);
    await parityWaitForState('menu selects', async () => !(await parityEval(`!!document.querySelector('[role="menu"]')`)), 15000);
    check('enter selects and restores trigger focus', await parityWaitForState('trigger focus restored', async () => (
        await parityEval(`(() => { const el = document.activeElement; return el && el.getAttribute && el.getAttribute('aria-label'); })()`)
    ), 15000) === 'Composer options');

    // A typed prompt sends through the real session.start fixture: the new
    // session route loads with the requested configuration. Any agent kind
    // works (the menu journey above may reselect); the title names it.
    // Type and send in separate tasks with a draft assertion between: React
    // flushes the draft on the input event, and the send must observe it.
    const typePrompt = async (text) => {
        await parityEval(`(() => {
            const box = [...document.querySelectorAll('textarea')].find((el) => el.offsetParent !== null)
                ?? [...document.querySelectorAll('input')].find((el) => el.placeholder && el.offsetParent !== null);
            if (!box) return;
            Object.getOwnPropertyDescriptor(box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
            box.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await parityWaitFor('draft arrives', (visible) => visible.includes(text), 15000);
        // State proof, not just DOM: the focused Send enables only when the
        // draft (not the DOM value) is non-empty.
        await parityWaitForState('send enables on draft', async () => await parityEval(`(() => {
            const sendButtons = [...document.querySelectorAll('*')].filter((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send' && el.offsetParent !== null);
            const sendButton = sendButtons[sendButtons.length - 1];
            return !!sendButton && sendButton.getAttribute('aria-disabled') !== 'true';
        })()`), 15000);
    };
    const clickFocusSend = async () => parityEval(`(() => {
        // The collapsed dock hides behind the focus modal but stays laid
        // out: take the last visible Send, which is the focused one.
        const sendButtons = [...document.querySelectorAll('*')].filter((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send' && el.offsetParent !== null);
        const sendButton = sendButtons[sendButtons.length - 1];
        if (!sendButton || sendButton.getAttribute('aria-disabled') === 'true') return 'not-ready';
        sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'sent';
    })()`);
    await clickDockEntry();
    await parityWaitFor('focus for send', (text) => text.includes('No worktree'));
    // Independent expectations (fixed constants, never derived from the
    // result): explicitly select this agent, project, and worktree state
    // before Send, then compare the title and transcript to the constants.
    const expectedKind = 'claude';
    const expectedAgentName = 'Claude Code';
    const expectedCwd = '/home/demo/acme-app';
    const expectedPrompt = 'parity spawn probe';
    const focusRowLabel = (prefix) => parityEval(`([...document.querySelectorAll('*')].map((el) => el.getAttribute && el.getAttribute('aria-label') || '').find((label) => label.startsWith(${JSON.stringify(prefix)})) ?? '')`);
    const clickFocusRow = (prefix) => parityEval(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && (el.getAttribute('aria-label') || '').startsWith(${JSON.stringify(prefix)}))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await clickFocusRow('AGENT, ');
    await parityWaitFor('agent sheet', (text) => text.includes(expectedAgentName), 15000);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === ${JSON.stringify(expectedAgentName)})?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitForState('agent picked', async () => (await focusRowLabel('AGENT, ')) === `AGENT, ${expectedAgentName}`, 15000);
    check('agent selection sticks', (await focusRowLabel('AGENT, ')) === `AGENT, ${expectedAgentName}`);
    await clickFocusRow('PROJECT, ');
    await parityWaitForState('project sheet input', async () => parityEval(`!![...document.querySelectorAll('input')].find((el) => (el.placeholder || '') === 'search or type a path' && el.offsetParent !== null)`), 15000);
    await parityEval(`(() => {
        const box = [...document.querySelectorAll('input')].find((el) => (el.placeholder || '') === 'search or type a path' && el.offsetParent !== null);
        if (!box) return 'missing';
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, ${JSON.stringify(expectedCwd)});
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed';
    })()`);
    // Synthetic typing never moves DOM focus and the sheet traps it on a
    // DIV, so CDP Enter cannot reach the input: dispatch keydown on the
    // node itself. React handles the bubbled event at its root through the
    // exact production submit path (RN TextInput → onSubmitCustom).
    await parityEval(`(() => {
        const box = [...document.querySelectorAll('input')].find((el) => (el.placeholder || '') === 'search or type a path' && el.offsetParent !== null);
        if (!box) return 'missing';
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return 'dispatched';
    })()`);
    await parityWaitForState('project picked', async () => (await focusRowLabel('PROJECT, ')) === `PROJECT, ${expectedCwd}`, 15000);
    check('project selection sticks', (await focusRowLabel('PROJECT, ')) === `PROJECT, ${expectedCwd}`);
    await clickFocusRow('WORKTREE, ');
    await parityWaitFor('worktree sheet', (text) => text.includes('No worktree'), 15000);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'No worktree')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitForState('worktree picked', async () => (await focusRowLabel('WORKTREE, ')) === 'WORKTREE, No worktree', 15000);
    check('worktree stays explicitly none', (await focusRowLabel('WORKTREE, ')) === 'WORKTREE, No worktree');
    await typePrompt(expectedPrompt);
    const sent = await clickFocusSend();
    check('compact focus send submits', sent === 'sent', sent);
    let createdPath = '/demo';
    try {
        createdPath = await waitPath('/session/demo-session-created');
    } catch (error) {
        const diag = await parityEval(`(() => {
            const text = document.body.innerText;
            const sendBtns = [...document.querySelectorAll('*')].filter((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send');
            return JSON.stringify({
                path: window.location.pathname,
                modal: (text.match(/.{0,60}(Please select a machine|could not start|Try again|Machine is offline|worktree.{0,40}failed|not scripted).{0,60}/) || [null])[0],
                sends: sendBtns.map((b) => b.getAttribute('aria-disabled')).join(','),
                menuOpen: !!document.querySelector('[role="menu"]'),
            });
        })()`);
        throw new Error(`no created session: ${diag} (${error instanceof Error ? error.message : String(error)})`);
    }
    // The created route must carry the independently selected kind: compare
    // the resulting title and transcript to the constants, never to
    // themselves. A regression that always starts Pi fails here.
    const createdTitle = await parityWaitFor('created session title', (text) => text.includes(`New ${expectedKind} session`), 20000);
    check('spawned session names the selected kind exactly', createdTitle.split('\n').some((line) => line.trim() === `New ${expectedKind} session`), expectedKind);

    // IME guard on the real session composer: Enter mid-composition must
    // not send (the draft stays); Enter after compositionend must send
    // (the draft clears). Real CompositionEvents through the production
    // hook wiring — no synthetic submit bypass.
    const sessionComposer = `[...document.querySelectorAll('input[placeholder="Type a prompt…"]')].find((el) => el.offsetParent !== null)`;
    const composerValue = () => parityEval(`(${sessionComposer}?.value ?? '')`);
    const imeProbe = 'ime guard probe';
    await parityEval(`(() => {
        const box = ${sessionComposer};
        if (!box) return;
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, ${JSON.stringify(imeProbe)});
        box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // Input values never reach innerText: poll the DOM property directly,
    // then assert an independent re-read (the poll throws on timeout).
    await parityWaitForState('ime draft arrives', async () => (await composerValue()) === imeProbe, 15000);
    check('ime draft arrives', (await composerValue()) === imeProbe);
    await parityEval(`(${sessionComposer})?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`);
    await pressKey('Enter', 'Enter', 13);
    await new Promise((r) => setTimeout(r, 2000));
    check('enter during composition does not send', (await composerValue()) === imeProbe);
    await parityEval(`(${sessionComposer})?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`);
    // The blocked submit still blurs (blurOnSubmit): refocus like a user
    // tapping back into the composer before sending for real.
    await parityEval(`(${sessionComposer})?.focus()`);
    await pressKey('Enter', 'Enter', 13);
    await parityWaitForState('composition draft clears', async () => (await composerValue()) === '', 15000);
    check('enter after composition sends', (await composerValue()) === '');

    await parityEval('window.history.back()');
    // The created session's transcript tail renders through pane.read into
    // the herd thumbnail: the exact selected kind, project, and both
    // prompts must be there textually — not inferred from canvas geometry.
    await parityWaitFor(
        'back to herd after spawn',
        (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES'),
        30000,
    );
    // The created card sits fourth in the live strip, past the preview
    // pause window: swipe it into view like a user, which unpauses its
    // pane.read thumbnail.
    const expectedSpawnLine = `$ new ${expectedKind} session in ${expectedCwd}`;
    const herdAfterScroll = await waitThumbnailLine('created thumbnail settles', `New ${expectedKind} session`, expectedSpawnLine);
    check('created transcript carries the selected kind and project', herdAfterScroll.includes(expectedSpawnLine), expectedKind);
    check('created transcript carries the dock prompt', herdAfterScroll.includes(`$ ${expectedPrompt}`));
    check('created transcript carries the composed prompt', herdAfterScroll.includes(`$ ${imeProbe}`));

    // Live resize across the breakpoint: the typed draft survives, no ghost
    // modal, no duplicate submission surface.
    await clickDockEntry();
    await parityWaitFor('focus for resize probe', (text) => text.includes('No worktree'));
    await typePrompt('resize survival probe');
    await pressKey('Escape', 'Escape', 27);
    await parityWaitFor('escape keeps the draft', (text) => !text.includes('No worktree'), 15000);
    await paritySend('Emulation.setDeviceMetricsOverride', { width: 901, height: 1024, deviceScaleFactor: 2, mobile: false });
    await new Promise((r) => setTimeout(r, 2500));
    await paritySend('Emulation.setDeviceMetricsOverride', { width: 899, height: 1024, deviceScaleFactor: 2, mobile: true });
    // Poll: dimension propagation + re-render under load takes longer than
    // the emulation round trip.
    const resizedText = await parityWaitFor('resized draft', (text) => text.includes('Migrate billing to usage-based plans') && text.includes('resize survival probe'), 30000);
    check('prompt survives 899-901-899 live resize', resizedText.includes('resize survival probe'));
    check('no ghost focus modal after resize', !(await testid('focus-composer')));

    // Compact session keeps the production chrome. Terminal proof comes
    // from the actual xterm buffer through the demo-only probe (channel →
    // decode → term.write → buffer), not from thumbnails or canvas size.
    // Headless capture cannot read WebGL pixels (preserveDrawingBuffer
    // stays off for production frame rate), so this test browser denies
    // WebGL and the production canvas fallback renders capturable text.
    await parityClickText('Rebase release branch onto main');
    await parityWaitFor('demo session', (text) => text.includes('^C'));
    check('session keeps production chrome', (await pathname()).startsWith('/session/'));
    // The demo frame follows into the session: identity plus the handoff.
    check('390 session keeps the demo bar', (await parityText()).includes('nothing is real') && await parityEval(`!![...document.querySelectorAll('[aria-label]')].find((el) => (el.getAttribute('aria-label') || '').startsWith('Connect your computer'))`));
    await checkCraft('390 session');
    const terminalBufferText = () => parityEval(`document.querySelector('[data-demo-terminal-text]')?.getAttribute('data-demo-terminal-text') ?? ''`);
    const bufferText = await (async () => {
        const started = Date.now();
        for (;;) {
            const text = await terminalBufferText();
            if (text.includes('rebased 4 commits cleanly') && text.includes('main: 12 new commits')) return text;
            if (Date.now() - started > 30000) throw new Error(`timed out waiting for xterm buffer proof (got ${JSON.stringify(text.slice(0, 200))})`);
            await new Promise((r) => setTimeout(r, 800));
        }
    })();
    check(
        'xterm buffer carries the delivered transcript',
        bufferText.includes('$ git fetch origin') && bufferText.includes('$ git rebase origin/main') && bufferText.includes('Needs approval: run git push --force-with-lease?'),
    );
    // Settle: channel replay plus the rAF frame-batching flush, then the
    // viewport the capture is taken in.
    await new Promise((r) => setTimeout(r, 3000));
    await paritySend('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 1500));
    await paritySend('Page.captureScreenshot', { format: 'jpeg', quality: 70 }).then((shot) => {
        if (attachmentsDir) {
            writeFileSync(`${attachmentsDir}/parity-390-session.jpg`, Buffer.from(shot.result.data, 'base64'));
            process.stdout.write(`shot ${attachmentsDir}/parity-390-session.jpg\n`);
        }
    });
    await parityEval('window.history.back()');
    const herdAfterSession = await parityWaitFor(
        'back to herd from session',
        (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES') && text.includes('rebased 4 commits cleanly'),
        30000,
    );
    check(
        'thumbnail pane.read path carries the transcript',
        herdAfterSession.includes('rebased 4 commits cleanly') && herdAfterSession.includes('main: 12 new commits') && herdAfterSession.includes('$ git fetch origin'),
    );
    check('browser back leaves the session for the herd', (await pathname()) === '/demo');

    // Settings gear routes like native; browser back returns.
    await parityClickLabel('Settings');
    await parityWaitFor('settings route', (text) => !text.includes('Migrate billing to usage-based plans'));
    check('settings gear routes like native', (await pathname()).startsWith('/settings'));
    await parityEval('window.history.back()');
    await parityWaitFor('back to herd again', (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES'));
    check('browser back leaves settings for the herd', (await pathname()) === '/demo');
    // Escape closes an open focus mode. Synthetic clicks never move DOM
    // focus, so tap the composer first like a user; otherwise Escape lands
    // on body and the keydown listener on the input never fires.
    await clickDockEntry();
    await parityWaitFor('refocus config', (text) => text.includes('No worktree'));
    await parityEval(`[...document.querySelectorAll('[data-testid="focus-composer"] input, [data-testid="focus-composer"] textarea')].find((el) => el.offsetParent !== null)?.focus()`);
    await parityWaitForState('composer focused', async () => (await activeElementLabel()) !== 'body', 10000);
    await pressKey('Escape', 'Escape', 27);
    await parityWaitFor('escape closes focus', (text) => !text.includes('No worktree'), 15000);
    check('escape closes focus mode', !(await parityText()).includes('No worktree'));

    // Width matrix screenshots + overflow checks + wide shell assertions.
    await parityShot('parity-390-light', 390, 844, '/demo', 'light');
    check('light theme keeps the demo legible', (await parityText()).includes('Migrate billing to usage-based plans'));
    await parityShot('parity-768-demo', 768, 1024, '/demo');
    await parityWaitFor('tablet herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('768 has no horizontal overflow', await noOverflow());
    await parityShot('parity-899-demo', 899, 1024, '/demo');
    await parityWaitFor('899 herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('899 stays compact with the dock', await dockEntryPresent());
    check('899 has no horizontal overflow', await noOverflow());
    await parityShot('parity-901-demo', 901, 1024, '/demo');
    await parityWaitFor('901 herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('901 switches to split desktop without the dock', !(await dockEntryPresent()));
    check('901 renders the real sidebar shell', await testid('sidebar'));
    {
        const wide = await parityText();
        check('901 sidebar carries Spaces', wide.includes('SPACES') && wide.includes('acme-app'));
        check('901 sidebar carries destinations', wide.includes('New session') && wide.includes('Usage') && wide.includes('Inbox') && wide.includes('Files') && wide.includes('Ports') && wide.includes('Settings'));
    }
    check('901 has no horizontal overflow', await noOverflow());
    await parityShot('parity-1280-demo', 1280, 800, '/demo');
    await parityWaitFor('desktop herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('1280 keeps the split desktop without the dock', !(await dockEntryPresent()));
    check('1280 renders the real sidebar shell', await testid('sidebar'));
    {
        const desktop = await parityText();
        check('1280 sidebar carries Spaces', desktop.includes('SPACES') && desktop.includes('acme-app'));
        check('1280 sidebar carries destinations', desktop.includes('New session') && desktop.includes('Usage') && desktop.includes('Inbox') && desktop.includes('Files') && desktop.includes('Ports') && desktop.includes('Settings'));
    }
    check('1280 has no horizontal overflow', await noOverflow());
    await checkCraft('1280 demo');
    await parityClickText('Rebase release branch onto main');
    await waitPath('/session');
    await parityWaitFor('desktop demo session', (text) => text.includes('^C'));
    check('1280 session keeps the demo bar', (await parityText()).includes('nothing is real'));
    await checkCraft('1280 session');
    check('1280 session has no horizontal overflow', await noOverflow());
    await parityEval('window.history.back()');
    await parityWaitFor('back to desktop herd', (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES'));
    // Desktop New Agent reuses the progressive flow with advanced options.
    await parityClickLabel('New session');
    await waitPath('/new-agent');
    const newAgentText = await parityWaitFor('new-agent desktop', (text) => text.includes('ADVANCED'));
    check('new-agent desktop shows the progressive flow', newAgentText.includes('START') && await testid('home-dock-entry'));
    check('new-agent desktop keeps advanced squad and join', /squad/i.test(newAgentText) && newAgentText.includes('JOIN A RUNNING WORKSPACE'));
    // Clean-host catalog: unavailable agents stay hidden behind an exact
    // count until revealed, each revealed entry carrying install guidance.
    // The inverted-count regression fails the exact label here.
    await parityWaitFor('unavailable toggle', (text) => text.includes('Show 2 more agents'), 30000);
    check('unavailable toggle shows the exact hidden count', (await parityText()).includes('Show 2 more agents'));
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Show 2 more agents')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const revealedText = await parityWaitFor('unavailable revealed', (text) => text.includes('Not installed'), 15000);
    check('revealed entries carry install guidance', revealedText.includes('Not installed') && revealedText.includes('cursor') && revealedText.includes('gemini'));
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Show installed agents only')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('unavailable hidden again', (text) => text.includes('Show 2 more agents') && !text.includes('Not installed'), 15000);
    check('reveal collapses back to installed-only', (await parityText()).includes('Show 2 more agents'));
    // Failed start retains the draft with an actionable error. Synthetic
    // input cannot cross the sheet modal's portal root, so the failure
    // drives the advanced squad flow on this desktop page instead: the
    // fixture refuses multi-kind starts (a squad is N tabs, not one
    // session), the error surfaces, and the squad stays selected.
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && (el.getAttribute('aria-label') || '').startsWith('pi, '))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && (el.getAttribute('aria-label') || '').startsWith('claude, '))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('squad picked', (text) => text.includes('SQUAD 2'), 15000);
    await parityEval(`(() => {
        const box = [...document.querySelectorAll('input')].find((el) => (el.placeholder || '').startsWith('/home/you/project') && el.offsetParent !== null);
        if (!box) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, '/home/demo/acme-app');
        box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Start squad (2)')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const failureText = await parityWaitFor('failure error', (text) => text.includes('Agent could not start. Try again.'), 30000);
    check('failed start shows an actionable error', failureText.includes('Agent could not start. Try again.'));
    check('failed start retains the squad draft', (await parityText()).includes('SQUAD 2'));
    check('failed start stays on the form', (await pathname()) === '/new-agent');

    // Real HomeDock failed start through the dock's own submit: a fresh
    // worktree cannot be created in the replayed non-repo directory, so
    // creation fails into an actionable alert, the prompt survives, and
    // dropping the worktree retries into a real session.
    await clickDockEntry();
    await parityWaitFor('dock focus for worktree probe', (text) => text.includes('No worktree'), 15000);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && (el.getAttribute('aria-label') || '').startsWith('WORKTREE, '))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('worktree sheet', (text) => text.includes('Create new worktree'), 15000);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Create new worktree')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('worktree picked', (text) => text.includes('Create new worktree') && !text.includes('No worktree'), 15000);
    await typePrompt('dock worktree probe');
    check('dock worktree send submits', (await clickFocusSend()) === 'sent');
    const worktreeAlert = await parityWaitFor('worktree failure alert', (text) => text.includes('Not a Git repository'), 30000);
    check('dock failure surfaces an actionable error', worktreeAlert.includes('Not a Git repository'));
    await parityEval(`[...[...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.innerText === 'OK')].pop()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('alert dismissed', (text) => !text.includes('Not a Git repository'), 15000);
    // The collapsed dock entry still carries the prompt: retention without
    // reopening anything.
    check('failed dock keeps the prompt for retry', (await parityText()).includes('dock worktree probe'));
    await clickDockEntry();
    await parityWaitFor('dock refocus for retry', (text) => text.includes('Create new worktree'), 15000);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && (el.getAttribute('aria-label') || '').startsWith('WORKTREE, '))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('worktree sheet again', (text) => text.includes('No worktree'), 15000);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'No worktree')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('worktree cleared', (text) => text.includes('No worktree') && !text.includes('Create new worktree'), 15000);
    check('retry send stays enabled', await parityWaitForState('retry send enabled', async () => parityEval(`(() => {
        const sendButtons = [...document.querySelectorAll('*')].filter((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send' && el.offsetParent !== null);
        const sendButton = sendButtons[sendButtons.length - 1];
        return !!sendButton && sendButton.getAttribute('aria-disabled') !== 'true';
    })()`), 15000) === true);
    check('retry submits', (await clickFocusSend()) === 'sent');
    const retryTitle = await parityWaitFor('retry session title', (text) => text.includes(`New ${expectedKind} session`), 30000);
    check('retry lands on the created session', retryTitle.split('\n').some((line) => line.trim() === `New ${expectedKind} session`) && (await pathname()).startsWith('/session/'), expectedKind);

    await parityEval('window.history.back()');
    await waitPath('/new-agent');
    // Focus submits intentionally leave their same-URL history entries
    // behind, so leaving for the herd takes one press per buried entry:
    // keep pressing until the route actually leaves.
    let herdPath = await pathname();
    for (let press = 0; press < 5 && herdPath !== '/demo'; press += 1) {
        await parityEval('window.history.back()');
        await new Promise((r) => setTimeout(r, 800));
        herdPath = await pathname();
    }
    await parityWaitFor('back to herd from new-agent', (text) => text.includes('Migrate billing to usage-based plans'));
    check('browser back leaves new-agent for the herd', (await pathname()) === '/demo', await pathname());
    // Same pause window as above: swipe until the retried prompt lands in
    // the created card's transcript.
    const herdAfterRetry = await waitThumbnailLine('retry transcript settles', `New ${expectedKind} session`, '$ dock worktree probe');
    check('retry prompt reaches the transcript', herdAfterRetry.includes('$ dock worktree probe'));
    check('no page errors during parity', parityErrors.length === 0, parityErrors.slice(0, 3).join(' | '));
} catch (cause) {
    check('demo browser flow completed', false, cause instanceof Error ? cause.message : String(cause));
} finally {
    await killAll();
}

if (failures.length > 0) {
    process.stderr.write(`checkDemoFlow: ${failures.length} failing check(s)\n`);
    process.exit(1);
}
process.stdout.write('checkDemoFlow: production /demo loop verified in Chromium\n');
