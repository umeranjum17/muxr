import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers(); health = 'up'; });

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
    const { usageNow } = await import('./usageNow.js');
    const cached = await usageNow(env, { refresh: true });

    // Two minutes on, a forced read collects every plan again.
    env.MUXR_USAGE_NOW = new Date(Date.now() + 120_000).toISOString();
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

it('keeps an agent its tab and names the scan failure once its measured days age out', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muxr-usage-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'kimi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const scanOk = join(home, 'scan-ok');
    const backend = join(bin, 'ccusage-backend');
    writeFileSync(backend, `#!/bin/sh\nif [ -f ${scanOk} ]; then printf '{"daily":[{"period":"%s","agents":[{"agent":"kimi","totalTokens":1240,"totalCost":0.5,"modelBreakdowns":[{"modelName":"kimi-latest","inputTokens":1200,"outputTokens":40,"cacheReadTokens":0,"cacheCreationTokens":0,"cost":0.5}]}]}]}' "$(date +%F)"; echo; else exit 1; fi\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { HOME: home, PATH: bin, MUXR_HOME: join(home, 'muxr'), MUXR_CCUSAGE_BIN: backend };
    const { collectUsage } = await import('./collectUsage.js');

    writeFileSync(scanOk, '');
    const measured = await collectUsage({ refresh: true }, env);
    expect(measured.provider).toBe('kimi');
    expect(measured.todayTokens).toBe('1.2K');

    // A day and an hour on, every scan still fails: past the 24h honesty cap
    // the measured figures give way, and the tab stays so the honest reason --
    // not "no supported providers" -- has somewhere to show.
    rmSync(scanOk);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    const aged = await collectUsage({ refresh: true }, env);
    expect(aged.providers.map(({ id }) => id)).toContain('kimi');
    expect(aged.provider).toBe('kimi');
    expect(aged.todayTokens).toBe('\u2014');
    expect(aged.activity?.state).toBe('unavailable');
    expect(aged.activity?.reason).toMatch(/reopen Usage in a minute/);
    expect(aged.noProviders).toBeUndefined();
}, 20_000);

it('answers the card and every Usage tab from one collection, and never lends a plan to an aggregator', async () => {
    const fetch = vi.fn(provider);
    vi.stubGlobal('fetch', fetch);
    const env = host();
    // Pi routed today's work to Z.ai and to Anthropic through an API key: two
    // providers, and Pi itself holds no plan.
    const sessions = join(env.PI_AGENT_DIR!, 'sessions', '--project--');
    mkdirSync(sessions, { recursive: true });
    const at = new Date(Date.now() - 60_000).toISOString();
    const turn = (id: string, provider: string, model: string, input: number, cost = 0.01) => JSON.stringify({
        type: 'message', id, timestamp: at,
        message: { role: 'assistant', provider, model, usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { total: cost } } },
    });
    // The subscription bridge records a cost of 0 on real tokens: it could
    // not price them, which is not the same as free.
    writeFileSync(join(sessions, 'a.jsonl'), `${turn('1', 'zai', 'glm-flash', 990)}\n${turn('2', 'anthropic', 'claude-sonnet', 190)}\n${turn('3', 'claude-bridge', 'claude-opus', 90, 0)}\n`);
    const { collectUsage } = await import('./collectUsage.js');
    const { usageNow } = await import('./usageNow.js');

    // The card's ask and a Usage tab's ask landing together -- the tap from
    // the card into the screen -- cost one collection, not one per reader.
    health = 'slow';
    const [card, report] = await Promise.all([
        usageNow(env, { refresh: true }),
        collectUsage({ provider: 'pi', refresh: true }, env),
    ]);
    const reads = fetch.mock.calls.length;
    expect(reads).toBe(2);
    expect(card.capturedAt).toBe(report.capturedAt);
    expect(report.provider).toBe('pi');
    expect(report.todayTokens).toBe('1.3K');
    // No borrowed plan: the card still shows the machine's tightest window,
    // while Pi's own limits are empty and each route speaks for its provider.
    expect(card.limits.windows).toHaveLength(1);
    expect(report.limits.windows).toEqual([]);
    expect(report.limits.plan).toBeUndefined();
    const routes = report.activity?.routes ?? [];
    expect(routes.map(({ id, today }) => [id, today])).toEqual([['zai', 1000], ['anthropic', 200], ['claude-bridge', 100]]);
    expect(routes[0]?.plan).toBe('Z.ai plan');
    expect(routes[1]?.windows).toBeUndefined();
    // Tokens with a recorded zero carry no dollar figure at all, never $0.00,
    // and no list price is guessed for them; priced routes keep theirs.
    expect(routes[1]?.weekCost).toBeCloseTo(0.01);
    expect(routes[2]?.weekCost).toBeUndefined();
    expect(routes[2]?.weekUnpriced).toBe(true);
    expect(report.activity?.days.at(-1)?.unpriced).toBe(true);

    // The Z.ai plan tab sees the traffic that spent it, and who sent it.
    const zai = await collectUsage({ provider: 'zai' }, env);
    expect(fetch.mock.calls).toHaveLength(reads);
    expect(zai.capturedAt).toBe(report.capturedAt);
    expect(zai.todayTokens).toBe('1.0K');
    expect(zai.activity?.sources?.map(({ id, week }) => [id, week])).toEqual([['pi', 1000]]);

    env.MUXR_USAGE_NOW = new Date(Date.now() + 61_000).toISOString();
    const [staleCard, staleTab] = await Promise.all([
        collectUsage({}, env), collectUsage({ provider: 'pi' }, env),
    ]);
    expect(staleCard.capturedAt).toBe(staleTab.capturedAt);
    expect(staleCard.capturedAt).not.toBe(report.capturedAt);
    expect(fetch.mock.calls).toHaveLength(reads + 2);
}, 20_000);
