import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

/** A host with Claude and Z.ai connected and nothing else installed. */
function host(): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(tmpdir(), 'muxr-usage-'));
    mkdirSync(join(home, 'claude'));
    writeFileSync(join(home, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-token', accountUuid: 'claude-account', expiresAt: Date.now() + 3_600_000 } }));
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

it('keeps the aged Claude plan while its token expires and reads Claude Code renewal', async () => {
    const fetch = vi.fn(provider);
    vi.stubGlobal('fetch', fetch);
    const env = host();
    const credentials = join(env.CLAUDE_CONFIG_DIR!, '.credentials.json');
    const save = (token: string, expiresAt: number) => writeFileSync(credentials, JSON.stringify({
        claudeAiOauth: { accessToken: token, accountUuid: 'claude-account', expiresAt },
    }));
    const { usageNow } = await import('./usageNow.js');
    const healthy = await usageNow(env, { refresh: true });
    expect(healthy.connected?.map(({ id }) => id)).toContain('claude');
    const firstReads = fetch.mock.calls.filter(([url]) => String(url).includes('anthropic')).length;

    // Two hours on, Claude Code has not run and its token has expired: the
    // reading from then stays on the card, aged, and nothing asks Anthropic.
    const plansFile = join(env.MUXR_HOME!, 'usage', 'plans-v1.json');
    const saved = JSON.parse(readFileSync(plansFile, 'utf8')) as { plans: Record<string, { at: number }> };
    for (const reading of Object.values(saved.plans)) reading.at -= 2 * 3_600_000;
    writeFileSync(plansFile, JSON.stringify(saved));
    save('claude-token', Date.now() - 1);
    const expired = await usageNow(env, { refresh: true });
    expect(expired.connected?.map(({ id }) => id)).toContain('claude');
    expect(expired.ageSeconds).toBeGreaterThanOrEqual(2 * 3_600 - 5);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('anthropic'))).toHaveLength(firstReads);

    // Claude Code renews its own token; the next refresh reads with it.
    save('renewed-token', Date.now() + 3_600_000);
    await usageNow(env, { refresh: true });
    expect(fetch.mock.calls.some(([url, init]) => String(url).includes('anthropic') &&
        new Headers(init?.headers).get('authorization') === 'Bearer renewed-token')).toBe(true);
    writeFileSync(join(env.CLAUDE_CONFIG_DIR!, 'last-statusline-input.json'), JSON.stringify(CLAUDE));
    rmSync(credentials);
    const disconnected = await usageNow(env, { refresh: true });
    expect(disconnected.connected?.some(({ id }) => id === 'claude')).toBe(false);
}, 20_000);

it('never answers with a cached day older than the plan readings stored since', async () => {
    vi.stubGlobal('fetch', vi.fn(provider));
    const env = host();
    const activity = join(env.HOME!, 'ccusage');
    writeFileSync(activity, '#!/bin/sh\necho \'{"daily":[],"session":[]}\'\n', { mode: 0o755 });
    env.MUXR_CCUSAGE_BIN = activity;
    const { usageNow } = await import('./usageNow.js');
    const cached = await usageNow(env, { refresh: true });

    // Two minutes on, local activity cannot be measured: the collection reads
    // every plan again, but the day's cached payload cannot be replaced.
    env.MUXR_USAGE_NOW = new Date(Date.now() + 120_000).toISOString();
    writeFileSync(activity, '#!/bin/sh\nexit 1\n');
    const fresh = await usageNow(env, { refresh: true });
    expect(fresh.capturedAt).not.toBe(cached.capturedAt);

    // The card's follow-up does not force a collection, and still gets the
    // newer reading rather than the day's replay.
    const next = await usageNow(env);
    expect(next.capturedAt).toBe(fresh.capturedAt);
}, 20_000);

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

it('answers the card and every Usage tab from one collection, however many readers ask', async () => {
    const fetch = vi.fn(provider);
    vi.stubGlobal('fetch', fetch);
    const env = host();
    // Local activity the tab's report can carry, measured the way ccusage
    // measures it: one agent, one day, one model.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const activity = join(env.HOME!, 'ccusage');
    writeFileSync(activity, `#!/bin/sh\necho '{"daily":[{"period":"${today}","agents":[{"agent":"opencode","totalTokens":1234,"totalCost":0.5,"modelBreakdowns":[{"modelName":"go-model","inputTokens":1000,"outputTokens":200,"cacheCreationTokens":0,"cacheReadTokens":34}]}]}],"session":[]}'\n`, { mode: 0o755 });
    env.MUXR_CCUSAGE_BIN = activity;
    const { collectUsage } = await import('./collectUsage.js');

    // The card's ask and a Usage tab's ask landing together -- the tap from
    // the card into the screen -- cost one collection, not one per reader.
    // The tab's answer carries the whole report, activity included.
    health = 'slow';
    const [now_, report] = await Promise.all([
        collectUsage({ refresh: true }, env),
        collectUsage({ provider: 'opencode', refresh: true }, env),
    ]);
    const reads = fetch.mock.calls.length;
    expect(reads).toBe(2);
    expect(now_.capturedAt).toBe(report.capturedAt);
    expect(report.provider).toBe('opencode');
    expect(report.providers.map(({ id }) => id)).toContain('opencode');
    expect(report.todayTokens).toBe('1.2K');
    expect(report.modelSeries.map(({ label }) => label)).toEqual(['go-model']);
    expect(existsSync(join(env.MUXR_HOME!, 'usage', 'usage-v2-all.json'))).toBe(false);

    // A second tab's forced ask right behind them re-collects, but the stored
    // plan readings answer for the providers: the rate limit is not spent
    // again, and the figures are the same ones the first collection landed.
    const other = await collectUsage({ provider: 'claude', refresh: true }, env);
    expect(fetch.mock.calls).toHaveLength(reads);
    expect(other.capturedAt).not.toBe(report.capturedAt);
    expect(other.windows).toEqual(now_.windows);
}, 20_000);

it('keeps a completed activity-only scan for card follow-ups without writing all agents to disk', async () => {
    const env = host();
    rmSync(join(env.CLAUDE_CONFIG_DIR!, '.credentials.json'));
    rmSync(join(env.PI_AGENT_DIR!, 'auth.json'));
    const activity = join(env.HOME!, 'ccusage');
    const today = new Date().toLocaleDateString('sv-SE');
    writeFileSync(activity, `#!/bin/sh\necho '{"daily":[{"period":"${today}","agents":[{"agent":"opencode","totalTokens":1234}]}],"session":[]}'\n`, { mode: 0o755 });
    env.MUXR_CCUSAGE_BIN = activity;
    const { collectUsage } = await import('./collectUsage.js');
    const first = await collectUsage({ refresh: true }, env);
    writeFileSync(activity, '#!/bin/sh\nexit 1\n');
    const next = await collectUsage({}, env);
    expect(next.capturedAt).toBe(first.capturedAt);
    expect(next.providers.map(({ id }) => id)).toContain('opencode');
    expect(existsSync(join(env.MUXR_HOME!, 'usage', 'usage-v2-all.json'))).toBe(false);
}, 20_000);
