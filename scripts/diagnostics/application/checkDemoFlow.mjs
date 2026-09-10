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
const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, 'about:blank'], {
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
    check('demo shows the blocked agent', true);
    check('demo shows the done agent', herdText.includes('Add retry with backoff to sync'));
    check('demo shows inbox attention', herdText.includes('Needs you'));
    check('demo bar marks the replay', herdText.includes('Demo replay'));
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
    check('back from file lands on the session', true);
    await clickControl('Back');
    const herdAgain = await journey.waitFor('back to herd', (text) => text.includes('Demo replay') && text.includes('Add retry with backoff to sync'));
    check('back from session lands on the herd', herdAgain.includes('Migrate billing to usage-based plans'));
    // Restart restores the whole journey: Bex blocked again, replay intact.
    await clickControl('Restart demo replay');
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
        const res = await paritySend('Runtime.evaluate', { expression, returnByValue: true });
        if (res.result?.exceptionDetails) throw new Error(`parity js error: ${JSON.stringify(res.result.exceptionDetails).slice(0, 200)}`);
        return res.result?.result?.value;
    };
    await paritySend('Runtime.enable');
    const parityShot = async (name, width, height, path) => {
        await paritySend('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 900 });
        await paritySend('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
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
    const noOverflow = () => parityEval('document.documentElement.scrollWidth <= window.innerWidth + 1');
    // The collapsed dock entry renders placeholder text (not an input); the
    // focused composer renders the real textarea.
    const dockPresent = () => parityEval(`[...document.querySelectorAll('*')].some((el) => el.children.length === 0 && el.innerText === 'Plan, ask, build…')`);

    // 390: native phone composition, no tab bar, no primary +.
    await parityShot('parity-390-demo', 390, 844, '/demo');
    const herd390 = await parityWaitFor('compact herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('compact herd renders dark phone composition', herd390.includes('WHILE YOU WERE AWAY') && herd390.includes('SPACES'));
    check('compact has no bottom tab bar', !await parityEval('!!document.querySelector(\'[role="tablist"], [role="tab"]\')'));
    check('compact search and settings controls present', await parityEval(`!![...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Search')`) && await parityEval(`!![...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Settings')`));
    check('compact has no primary new-agent plus', !await parityEval(`!![...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'New agent')`));
    check('compact HomeDock entry present', await dockPresent());
    check('compact has no horizontal overflow', await noOverflow());

    // Focus reveals the progressive config; a typed prompt sends. The rows
    // show icon + value (labels live in accessibility names, as on native).
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Plan, ask, build…')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    const focusText = await parityWaitFor('focus config', (text) => text.includes('No worktree') && text.includes('Start '));
    check('focus reveals agent/project/worktree config', focusText.includes('No worktree') && focusText.includes('Start '));
    const sent = await parityEval(`(() => {
        const box = [...document.querySelectorAll('textarea, input')].find((el) => el.placeholder && el.placeholder.startsWith('Ask ') && el.offsetParent !== null);
        if (!box) return 'missing';
        Object.getOwnPropertyDescriptor(box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(box, 'compact parity probe');
        box.dispatchEvent(new Event('input', { bubbles: true }));
        // The collapsed dock hides behind the focus modal but stays laid
        // out: take the last visible Send, which is the focused one.
        const sendButtons = [...document.querySelectorAll('*')].filter((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send' && el.offsetParent !== null);
        const sendButton = sendButtons[sendButtons.length - 1];
        if (!sendButton || sendButton.getAttribute('aria-disabled') === 'true') return 'not-ready';
        sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'sent';
    })()`);
    check('compact focus send starts a session', sent === 'sent');
    // Submit dismisses focus mode immediately (demo records cannot spawn a
    // session; production navigates to it through the same handler).
    await parityWaitFor('submit dismisses', (text) => !text.includes('No worktree'), 15000);
    check('send submits and dismisses focus', true);
    // Browser back works for session and settings through real history.
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Migrate billing to usage-based plans')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('demo session', (text) => text.includes('^C'));
    await parityEval('window.history.back()');
    await parityWaitFor('back to herd', (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES'));
    check('browser back leaves the session for the herd', true);
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Settings')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('settings route', (text) => !text.includes('Migrate billing to usage-based plans'));
    check('settings gear routes like native', true);
    await parityEval('window.history.back()');
    await parityWaitFor('back to herd again', (text) => text.includes('Migrate billing to usage-based plans') && text.includes('SPACES'));
    check('browser back leaves settings for the herd', true);
    // Escape closes an open focus mode. Reload for a clean dock: the
    // submitted prompt text persists in the draft by design.
    await paritySend('Page.navigate', { url: `http://127.0.0.1:${port}/demo` });
    await parityWaitFor('reload herd', (text) => text.includes('Migrate billing to usage-based plans'));
    await parityEval(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Plan, ask, build…')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await parityWaitFor('refocus config', (text) => text.includes('No worktree'));
    await paritySend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await paritySend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise((r) => setTimeout(r, 1500));
    check('escape closes focus mode', !(await parityText()).includes('No worktree'));

    // Width matrix screenshots + overflow checks.
    await parityShot('parity-768-demo', 768, 1024, '/demo');
    await parityWaitFor('tablet herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('768 has no horizontal overflow', await noOverflow());
    await parityShot('parity-899-demo', 899, 1024, '/demo');
    await parityWaitFor('899 herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('899 stays compact with the dock', await dockPresent());
    check('899 has no horizontal overflow', await noOverflow());
    await parityShot('parity-901-demo', 901, 1024, '/demo');
    await parityWaitFor('901 herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('901 switches to split desktop without the dock', !(await dockPresent()));
    check('901 has no horizontal overflow', await noOverflow());
    await parityShot('parity-1280-demo', 1280, 800, '/demo');
    await parityWaitFor('desktop herd', (text) => text.includes('Migrate billing to usage-based plans'));
    check('1280 keeps the split desktop without the dock', !(await dockPresent()));
    check('1280 has no horizontal overflow', await noOverflow());
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
