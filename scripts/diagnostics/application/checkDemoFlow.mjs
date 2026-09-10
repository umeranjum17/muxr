/**
 * Demo replay browser flow: serves the REAL production export, drives the
 * REAL /demo route in headless Chromium over CDP, and walks the full loop —
 * production herd → blocked agent → real session terminal → real composer
 * send → working → done → Inbox reconciles. No new dependencies: system
 * Chromium, the existing static server, the Node 22 global WebSocket, and
 * polling waits (no fixed-sleep races).
 *
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

const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
    });
});
const CDP_PORT = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
    });
});

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

try {
    await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('static server did not come up')), 10_000);
        const probe = async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/index.html`);
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
    await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('cdp endpoint did not come up')), 15_000);
        const probe = async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
                if (response.ok) {
                    clearTimeout(deadline);
                    resolve();
                } else {
                    setTimeout(() => void probe(), 200);
                }
            } catch {
                setTimeout(() => void probe(), 200);
            }
        };
        void probe();
    });

    const tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = tabs.find((tab) => tab.type === 'page');
    if (!page) throw new Error('no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(String(event.data));
            if (msg.id !== undefined && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
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
    // Capture page errors throughout the journey, not just body text: a
    // crash behind an error boundary still leaves rendered text behind.
    const pageErrors = [];
    const errorListener = (event) => {
        try {
            const msg = JSON.parse(String(event.data));
            if (msg.method === 'Runtime.exceptionThrown') {
                pageErrors.push(`exception: ${JSON.stringify(msg.params?.exceptionDetails?.text ?? msg.params?.exceptionDetails).slice(0, 300)}`);
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
                const text = (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 300);
                pageErrors.push(`console.error: ${text}`);
            }
        } catch {}
    };
    ws.addEventListener('message', errorListener);
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

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/demo` });
    // Real hidden→visible transition BEFORE asserting the herd: the demo
    // must not perform a socket visibility reconnect (tearing down the
    // deterministic transport used to brick the herd until reload), and the
    // transport must survive close/reopen regardless.
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
    const herdText = await waitFor('herd', (text) => text.includes('Rebase release branch onto main'));
    check('demo shows the working agent', herdText.includes('Migrate billing to usage-based plans'));
    check('demo shows the blocked agent', true);
    check('demo shows the done agent', herdText.includes('Add retry with backoff to sync'));
    check('demo shows inbox attention', herdText.includes('Needs you'));
    check('demo bar marks the replay', herdText.includes('Demo replay'));
    check('demo never shows the unpaired pairing root', !herdText.includes('Enter pairing string'));
    check('demo boots without init errors', !herdText.includes('Error initializing'));

    // Open the blocked agent's real session terminal with one bubbled click.
    await evaluate(`[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.innerText === 'Rebase release branch onto main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    // innerText carries visible labels only (^C, not the Control C
    // accessibility label; placeholders never appear) — assert those, and
    // the composer input via the DOM directly.
    const sessionText = await waitFor('session', (text) => text.includes('Rebase release branch onto main') && text.includes('^C'));
    check('blocked row opens the real session', sessionText.includes('Rebase release branch onto main'));
    check('real keys row renders from the plugin manifest', sessionText.includes('^C') && sessionText.includes('esc'));
    const composerPresent = await (async () => {
        const started = Date.now();
        for (;;) {
            const present = await evaluate(`!!document.querySelector('input[placeholder="Type a prompt…"]')`);
            if (present === true) return true;
            if (Date.now() - started > 30000) return present;
            await new Promise((r) => setTimeout(r, 500));
        }
    })();
    check('real composer is live', composerPresent === true);
    check('no install prompt on the demo route', !sessionText.includes('Install the app'));

    // Approve through the real composer (native setter so React sees it).
    // The composer can remount as the terminal attaches, so find-set-click
    // retries as one unit instead of assuming a stable node.
    await (async () => {
        const started = Date.now();
        for (;;) {
            const sent = await evaluate(`(() => {
                const box = document.querySelector('input[placeholder="Type a prompt…"]');
                if (!box) return 'missing';
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, 'approved, push it');
                box.dispatchEvent(new Event('input', { bubbles: true }));
                const sendButton = [...document.querySelectorAll('*')].find((el) => el.getAttribute && el.getAttribute('aria-label') === 'Send');
                if (!sendButton || sendButton.getAttribute('aria-disabled') === 'true') return 'not-ready';
                sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 'sent';
            })()`);
            if (sent === 'sent') return;
            if (Date.now() - started > 30000) throw new Error(`composer never became sendable (last: ${sent})`);
            await new Promise((r) => setTimeout(r, 500));
        }
    })();
    await evaluate('window.history.back()');
    const reconciled = await waitFor(
        'reconciliation',
        (text) => text.includes('in sync with main') && !text.includes('Needs you'),
        30000,
    );
    check('approval visibly continues the agent', reconciled.includes('in sync with main'));
    check('agent reaches done', reconciled.includes('Done'));
    check('inbox reconciles after done', !reconciled.includes('Needs you'));
    check('no page errors during the journey', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    ws.close();
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
