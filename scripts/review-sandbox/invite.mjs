// Adapted from muxr-cloud scripts/review-invite-server.mjs (revision 43475e168dfbb01733e54d9985c66d73b69d527e).
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';

const port = Number(process.env.PORT ?? 8080);
const tokenHash = process.env.REVIEW_INVITE_TOKEN_HASH ?? '';
const expiresAt = Date.parse(process.env.REVIEW_INVITE_EXPIRES_AT ?? '');
const maxClaims = Number(process.env.REVIEW_INVITE_MAX_CLAIMS ?? 20);
const pairingFile = process.env.REVIEW_PAIRING_FILE ?? '/home/reviewer/.muxr/pairing-offer.txt';
const stateFile = process.env.REVIEW_INVITE_STATE_FILE ?? '/home/reviewer/.muxr/review-invite.json';
const muxrBin = process.env.MUXR_BIN ?? '/usr/bin/muxr';
const pairingTimeoutMs = Number(process.env.REVIEW_PAIRING_TIMEOUT_MS ?? 20_000);
// Stop reusing a pairing link this close to expiry so a reviewer who opens it
// right away still lands inside the offer's single-use window.
const minPairingLifetimeMs = 30_000;

if (!/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isFinite(expiresAt) || !Number.isSafeInteger(maxClaims) || maxClaims < 1
    || !Number.isSafeInteger(pairingTimeoutMs) || pairingTimeoutMs < 1) {
    throw new Error('review invite configuration is invalid');
}

// byokit pairing offers: `muxr pair` prints `byokit-link:1:<base64url(JSON)>`;
// wrapped as muxr://pair#<offer> the link opens the app's Pair screen directly.
const OFFER = /^byokit-link:1:[A-Za-z0-9_-]+$/;
const OFFER_SCAN = /byokit-link:1:[A-Za-z0-9_-]+/g;
const APPROVAL_PROMPT = /Approve this device\?|wants to pair with this computer/;

const offerExpiry = (offer) => {
    try {
        const decoded = JSON.parse(Buffer.from(offer.slice('byokit-link:1:'.length), 'base64url').toString('utf8'));
        return Number.isFinite(decoded.expires) ? decoded.expires : undefined;
    } catch {
        return undefined;
    }
};

const hash = (value) => createHash('sha256').update(value).digest();
const expectedHash = Buffer.from(tokenHash, 'hex');
const authorized = (value) => {
    const actual = hash(value);
    return actual.length === expectedHash.length && timingSafeEqual(actual, expectedHash);
};

async function readState() {
    try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
        return Number.isSafeInteger(parsed.claims) && parsed.claims >= 0 ? parsed : { claims: 0 };
    } catch (error) {
        if (error?.code === 'ENOENT') return { claims: 0 };
        throw error;
    }
}

async function writeFileAtomic(path, value, mode) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, value, { mode });
    await rename(temporary, path);
}

const writeState = (state) => writeFileAtomic(stateFile, `${JSON.stringify(state)}\n`, 0o600);
const writeOffer = (offer) => writeFileAtomic(pairingFile, `${offer}\n`, 0o600);

// One `muxr pair` at a time; its printed offer stays live only while it runs.
let pairingProcess;
let pairingGeneration = 0;

function stopPairing() {
    const session = pairingProcess;
    pairingProcess = undefined;
    pairingGeneration += 1;
    if (session?.child.exitCode === null) session.child.kill('SIGTERM');
}

async function currentPairing() {
    try {
        const offer = (await readFile(pairingFile, 'utf8')).trim();
        const expiry = OFFER.test(offer) ? offerExpiry(offer) : undefined;
        if (expiry === undefined || pairingProcess === undefined || pairingProcess.child.exitCode !== null) return undefined;
        return expiry - Date.now() >= minPairingLifetimeMs ? offer : undefined;
    } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
}

async function createPairing() {
    stopPairing();
    await rm(pairingFile, { force: true });
    const generation = pairingGeneration;
    return new Promise((resolve, reject) => {
        // The review VM is unattended, so run `muxr pair` under util-linux
        // `script`: its y/N confirmation prompt needs a terminal, and the
        // broker answers it (the sandbox is disposable and holds nothing
        // sensitive; the reviewer still confirms inside the app).
        const child = spawn('script', ['-qec', `${muxrBin} pair`, '/dev/null'], {
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const session = { child };
        pairingProcess = session;
        let output = '';
        let stderr = '';
        let settled = false;
        let offersSeen = 0;
        let approvals = 0;
        let offer;
        const timer = setTimeout(() => fail(new Error('muxr pairing process timed out before producing a pairing link')), pairingTimeoutMs);
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null) child.kill('SIGTERM');
            reject(error);
        };
        const succeed = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(offer);
        };
        const consider = () => {
            const matches = [...output.matchAll(OFFER_SCAN)];
            if (matches.length > 0) {
                const latest = matches.at(-1)[0];
                if (latest !== offer) {
                    offersSeen += 1;
                    offer = latest;
                    writeOffer(offer).then(() => {
                        if (offerExpiry(offer) - Date.now() >= minPairingLifetimeMs) succeed();
                    }, fail);
                }
            }
            // One answer per printed prompt: pairing, rotated offers, and
            // further claims each prompt again.
            if (approvals < offersSeen && APPROVAL_PROMPT.test(output)) {
                approvals = offersSeen;
                child.stdin.write('y\r');
            }
        };
        child.stdout.on('data', (chunk) => {
            output += chunk;
            if (output.length > 262_144) { fail(new Error('muxr pairing process produced unexpected output')); return; }
            consider();
        });
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-65_536);
        });
        child.on('error', fail);
        child.on('exit', () => {
            if (pairingProcess === session) {
                pairingProcess = undefined;
                pairingGeneration += 1;
                rm(pairingFile, { force: true }).catch(() => {});
            }
            if (stderr.trim() !== '') process.stderr.write(`muxr pair: ${stderr.trim()}\n`);
            fail(new Error('muxr pairing process exited before producing a pairing link'));
        });
        if (generation !== pairingGeneration) fail(new Error('pairing was superseded'));
    });
}

// The offer is validated against OFFER, so the link is attribute-safe as is.
function html(pairing) {
    const link = `muxr://pair#${pairing}`;
    const encoded = JSON.stringify(link);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect muxr review sandbox</title><style>body{font:16px system-ui;max-width:42rem;margin:10vh auto;padding:1.5rem;background:#111;color:#eee}main{padding:1.5rem;border:1px solid #333;border-radius:16px;background:#181818}code{display:block;padding:1rem;margin:1rem 0;overflow-wrap:anywhere;background:#090909;border-radius:10px}a.button,button{display:inline-block;padding:.8rem 1rem;margin-right:.5rem;border:0;border-radius:9px;font-weight:700;text-decoration:none;color:#111;background:#eee}</style></head><body><main><h1>Connect the review sandbox</h1><p>This grants access only to a disposable muxr review workspace.</p><a class="button" id="open" href="${link}">Open in muxr</a><code id="pairing"></code><button id="copy">Copy pairing link</button><p>Tap <strong>Open in muxr</strong> &mdash; the link opens the app's Pair screen directly. Confirm there; the sandbox approves its side automatically. The link is single-use and expires within two minutes; reload this page for a fresh one.</p></main><script>const pairing=${encoded};document.querySelector('#pairing').textContent=pairing;document.querySelector('#copy').onclick=()=>navigator.clipboard.writeText(pairing);</script></body></html>`;
}

let activePair;
function pairingOnce() {
    if (activePair) return activePair;
    activePair = createPairing().finally(() => { activePair = undefined; });
    return activePair;
}

const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');

    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        const match = req.method === 'GET' ? /^\/invite\/([^/]+)$/.exec(url.pathname) : undefined;
        if (!match || !authorized(match[1])) {
            res.writeHead(404).end();
            return;
        }
        if (Date.now() >= expiresAt) {
            res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('This review invitation has expired.');
            return;
        }
        const state = await readState();
        const reusable = await currentPairing();
        if (!reusable && state.claims >= maxClaims) {
            res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('This review invitation has reached its claim limit.');
            return;
        }
        const pairing = reusable ?? await pairingOnce();
        if (!reusable) await writeState({ claims: state.claims + 1, lastClaimedAt: new Date().toISOString() });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html(pairing));
    } catch {
        stopPairing();
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' });
        res.end('The review sandbox is preparing a fresh pairing link. Reload in a few seconds.');
    }
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`review invite broker listening on 127.0.0.1:${port}\n`));

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        stopPairing();
        process.exit(0);
    });
}
