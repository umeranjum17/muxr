/**
 * Public surfaces are cached and remote: every read is individually timed out,
 * and retried on a wrong answer as well as a failed one.
 *
 * The raw catalog is served by a CDN that holds a branch file for around five
 * minutes, and a query string does not bust it; the site adds its own short
 * TTL on top. Convergence therefore has to be waited out, so callers share one
 * deadline across every surface instead of giving each its own worst case.
 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 5000;
// Registry reads keep their own budget: a fresh publish can lag on the first
// lookups, and that wait is unrelated to public-surface convergence.
const REGISTRY_READ_TIMEOUT_MS = 20000;
const REGISTRY_ATTEMPTS = 10;
const REGISTRY_DELAY_MS = 3000;
/** Comfortably past the raw CDN's window, and well inside the publish job. */
export const PUBLIC_CONVERGENCE_MS = 420000;

export function publicDeadline(withinMs = PUBLIC_CONVERGENCE_MS) {
    return Date.now() + withinMs;
}

/** Never outlive the shared budget: every attempt is clamped to what is left. */
function request(url, deadline, options = {}) {
    const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Math.floor(deadline - Date.now())));
    return fetch(url, { signal: AbortSignal.timeout(timeout), ...options });
}

/**
 * Attempts until the shared deadline, and no further: no request is issued
 * once the budget is gone, and a wait never runs past it. The last real
 * mismatch is what gets reported, not the expiry.
 */
async function attempt(deadline, delayMs, read) {
    let detail = 'no response';
    for (let round = 0; ; round += 1) {
        if (round > 0) {
            const before = deadline - Date.now();
            if (before <= 0) return detail;
            await sleep(Math.min(delayMs, before));
        }
        if (deadline - Date.now() <= 0) return detail;
        detail = await read();
        if (detail === undefined) return undefined;
    }
}

export async function readPublicJson(url, { deadline = publicDeadline(), delayMs = RETRY_DELAY_MS, expect } = {}) {
    let served;
    const failure = await attempt(deadline, delayMs, async () => {
        try {
            const response = await request(url, deadline, { redirect: 'follow', headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
            if (!response.ok) return `HTTP ${response.status}`;
            const value = await response.json();
            const mismatch = expect === undefined ? undefined : expect(value);
            if (mismatch !== undefined) return mismatch;
            served = value;
            return undefined;
        } catch (cause) { return cause.message; }
    });
    if (failure !== undefined) throw new Error(`${url} did not serve the expected record (${failure})`);
    return served;
}

export async function readPublicText(url, { deadline = publicDeadline(), delayMs = RETRY_DELAY_MS, expect } = {}) {
    let served;
    const failure = await attempt(deadline, delayMs, async () => {
        try {
            const response = await request(url, deadline, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
            if (!response.ok) return `HTTP ${response.status}`;
            const value = await response.text();
            const mismatch = expect === undefined ? undefined : expect(value);
            if (mismatch !== undefined) return mismatch;
            served = value;
            return undefined;
        } catch (cause) { return cause.message; }
    });
    if (failure !== undefined) throw new Error(`${url} did not serve the expected content (${failure})`);
    return served;
}

/** Requires a real redirect to the exact expected target, retrying a wrong one. */
export async function requireRedirect(url, expectedLocation, { deadline = publicDeadline(), delayMs = RETRY_DELAY_MS } = {}) {
    let served;
    const failure = await attempt(deadline, delayMs, async () => {
        try {
            const response = await request(url, deadline, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } });
            const location = response.headers.get('location');
            if (response.status < 300 || response.status > 399) return `HTTP ${response.status} is not a redirect`;
            if (location !== expectedLocation) return `redirects to ${location ?? 'nothing'}`;
            served = { status: response.status, location };
            return undefined;
        } catch (cause) { return cause.message; }
    });
    if (failure !== undefined) throw new Error(`${url} did not redirect to ${expectedLocation} (${failure})`);
    return served;
}

/** The registry is the channel's source of truth; reads are retried, never assumed. */
export async function readRegistryDistTag({ package: name, tag, attempts = REGISTRY_ATTEMPTS, delayMs = REGISTRY_DELAY_MS }) {
    const { spawnSync } = await import('node:child_process');
    let detail = 'no response';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(delayMs);
        const result = spawnSync('npm', ['view', name, `dist-tags.${tag}`, '--json'], { encoding: 'utf8', timeout: REGISTRY_READ_TIMEOUT_MS });
        if (result.status === 0 && result.stdout.trim() !== '') return JSON.parse(result.stdout.trim());
        detail = (result.stderr || result.error?.message || 'empty registry response').trim().slice(-300);
    }
    throw new Error(`npm dist-tag ${tag} for ${name} could not be read (${detail})`);
}

export async function readRegistryIntegrity({ package: name, version, attempts = REGISTRY_ATTEMPTS, delayMs = REGISTRY_DELAY_MS }) {
    const { spawnSync } = await import('node:child_process');
    let detail = 'no response';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(delayMs);
        const result = spawnSync('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json'], { encoding: 'utf8', timeout: REGISTRY_READ_TIMEOUT_MS });
        if (result.status === 0 && result.stdout.trim() !== '') return JSON.parse(result.stdout.trim());
        detail = (result.stderr || result.error?.message || 'empty registry response').trim().slice(-300);
    }
    throw new Error(`npm integrity for ${name}@${version} could not be read (${detail})`);
}
