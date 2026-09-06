/**
 * Public surfaces are cached and remote: every read is individually timed out,
 * bounded in attempts, and retried on a wrong answer as well as a failed one.
 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const REQUEST_TIMEOUT_MS = 20000;
// Registry metadata reads are small; a stalled one must not eat the job budget.
const REGISTRY_READ_TIMEOUT_MS = 20000;

function request(url, options = {}) {
    return fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...options });
}

/** Metadata URLs sit behind minutes-long CDN caches; revalidate and bust them. */
export function cacheBusted(url, attempt) {
    const target = new URL(url);
    target.searchParams.set('t', `${Math.floor(Date.now() / 1000)}-${attempt}`);
    return target.toString();
}

export async function readPublicJson(url, { attempts = 10, delayMs = 3000, expect, bust = false } = {}) {
    let detail = 'no response';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(delayMs);
        try {
            const response = await request(bust ? cacheBusted(url, attempt) : url, {
                redirect: 'follow',
                headers: { accept: 'application/json', 'cache-control': 'no-cache' },
            });
            if (!response.ok) { detail = `HTTP ${response.status}`; continue; }
            const value = await response.json();
            const mismatch = expect === undefined ? undefined : expect(value);
            if (mismatch === undefined) return value;
            detail = mismatch;
        } catch (cause) { detail = cause.message; }
    }
    throw new Error(`${url} did not serve the expected record (${detail})`);
}

export async function readPublicText(url, { attempts = 10, delayMs = 3000, expect } = {}) {
    let detail = 'no response';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(delayMs);
        try {
            const response = await request(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
            if (!response.ok) { detail = `HTTP ${response.status}`; continue; }
            const value = await response.text();
            const mismatch = expect === undefined ? undefined : expect(value);
            if (mismatch === undefined) return value;
            detail = mismatch;
        } catch (cause) { detail = cause.message; }
    }
    throw new Error(`${url} did not serve the expected content (${detail})`);
}

/** Requires a real redirect to the exact expected target, retrying a wrong one. */
export async function requireRedirect(url, expectedLocation, { attempts = 12, delayMs = 5000 } = {}) {
    let detail = 'no response';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(delayMs);
        try {
            const response = await request(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } });
            const location = response.headers.get('location');
            if (response.status < 300 || response.status > 399) { detail = `HTTP ${response.status} is not a redirect`; continue; }
            if (location === expectedLocation) return { status: response.status, location };
            detail = `redirects to ${location ?? 'nothing'}`;
        } catch (cause) { detail = cause.message; }
    }
    throw new Error(`${url} did not redirect to ${expectedLocation} (${detail})`);
}

/** The registry is the channel's source of truth; reads are retried, never assumed. */
export async function readRegistryDistTag({ package: name, tag, attempts = 10, delayMs = 3000 }) {
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

export async function readRegistryIntegrity({ package: name, version, attempts = 10, delayMs = 3000 }) {
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
