import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

/** A host with Claude and Z.ai connected and nothing else installed. */
function host(): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(tmpdir(), 'muxr-usage-'));
    mkdirSync(join(home, 'claude'));
    writeFileSync(join(home, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-token', expiresAt: Date.now() + 3_600_000 } }));
    mkdirSync(join(home, 'pi'));
    writeFileSync(join(home, 'pi', 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'zai-token' } }));
    return {
        HOME: home, PATH: '', MUXR_HOME: join(home, 'muxr'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
        PI_AGENT_DIR: join(home, 'pi'), XDG_DATA_HOME: join(home, 'share'), MUXR_CCUSAGE_BIN: '/bin/false',
    };
}

const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
const CLAUDE = { five_hour: { utilization: 10, resets_at: resetsAt }, seven_day: { utilization: 40, resets_at: resetsAt } };
const ZAI = { success: true, data: { limits: [{ unit: 3, number: 5, percentage: 20, nextResetTime: Date.now() + 3_600_000 }] } };

/** Providers as they behave: Anthropic refuses a caller that is not Claude
 *  Code, and `health` decides whether each answers at all. */
let health: 'up' | 'down' | 'slow' = 'up';
function provider(url: string, init?: RequestInit): Promise<Response> {
    const agent = new Headers(init?.headers).get('user-agent') ?? '';
    const answer = (): Response => {
        if (health === 'down') return new Response('{}', { status: url.includes('anthropic') ? 429 : 503 });
        if (url.includes('anthropic')) return agent.startsWith('claude-code/') ? Response.json(CLAUDE) : new Response('{}', { status: 429 });
        return Response.json(ZAI);
    };
    return health === 'slow' ? new Promise((resolve) => setTimeout(() => resolve(answer()), 3_000)) : Promise.resolve(answer());
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); health = 'up'; });

it('keeps every plan on the card through failed reads and paints the last good reading after a restart', async () => {
    vi.stubGlobal('fetch', vi.fn(provider));
    const env = host();
    const plans = (now: { connected?: { id: string }[] }) => (now.connected ?? []).map((plan) => plan.id).sort();

    let { usageNow } = await import('./usageNow.js');
    const healthy = await usageNow(env, { refresh: true });
    expect(plans(healthy)).toEqual(['claude', 'zai']);
    expect(healthy.refreshing).toBeUndefined();

    // Two minutes on, past the window in which a reading is simply reused,
    // both providers fail -- Anthropic rate-limits, Z.ai errors twice -- and
    // neither leaves the card: each stands on its last reading.
    env.MUXR_USAGE_NOW = new Date(Date.now() + 120_000).toISOString();
    health = 'down';
    const failing = await usageNow(env, { refresh: true });
    expect(plans(failing)).toEqual(['claude', 'zai']);
    expect(failing.collecting).toBeUndefined();

    // A restarted host whose providers are slow paints the reading on disk
    // at once, says a refresh is running, and serves that refresh once it lands.
    vi.resetModules();
    ({ usageNow } = await import('./usageNow.js'));
    health = 'slow';
    const started = Date.now();
    const restarted = await usageNow(env, { refresh: true });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(plans(restarted)).toEqual(['claude', 'zai']);
    expect(restarted.refreshing).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const landed = await usageNow(env);
    expect(landed.refreshing).toBeUndefined();
    expect(landed.capturedAt).not.toBe(restarted.capturedAt);
    expect(plans(landed)).toEqual(['claude', 'zai']);
}, 20_000);
