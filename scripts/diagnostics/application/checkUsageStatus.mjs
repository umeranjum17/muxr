import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {};
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** One recorded assistant response, in the Pi transcript format OMP and Pi both write. */
function record(id, at, model, counts, cost) {
    const usage = {
        input: counts.input ?? 0, output: counts.output ?? 0, cacheRead: counts.cacheRead ?? 0, cacheWrite: counts.cacheWrite ?? 0,
        totalTokens: (counts.input ?? 0) + (counts.output ?? 0) + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0),
        ...(cost === undefined ? {} : { cost: { total: cost } }),
    };
    return JSON.stringify({ id, parentId: null, type: 'message', timestamp: at, message: { role: 'assistant', model, timestamp: at, usage } });
}

function writeTranscript(path, lines) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`);
}

function seedDatabase(path, schema, insert, params) {
    if (DatabaseSync) {
        const db = new DatabaseSync(path);
        try { db.exec(schema); db.prepare(insert).run(...params); } finally { db.close(); }
        return;
    }
    const seeded = spawnSync('python3', ['-c', 'import json,sqlite3,sys; p,s,i,a=json.load(sys.stdin); d=sqlite3.connect(p); d.execute(s); d.execute(i,a); d.commit(); d.close()'], {
        input: JSON.stringify([path, schema, insert, params]), encoding: 'utf8', timeout: 2_000,
    });
    assert.equal(seeded.status, 0, 'SQLite fixtures require Node 22.13+ or Python 3');
}

// The same platform map the collector ships with: pinning one target would test
// a binary the release never runs anywhere else.
const ccusageTarget = {
    'darwin-arm64': '@ccusage/ccusage-darwin-arm64', 'darwin-x64': '@ccusage/ccusage-darwin-x64',
    'linux-arm64': '@ccusage/ccusage-linux-arm64', 'linux-x64': '@ccusage/ccusage-linux-x64',
}[`${process.platform}-${process.arch}`];
assert.ok(ccusageTarget, `Usage has no ccusage backend for ${process.platform}-${process.arch}`);
const ccusageBinary = createRequire(import.meta.url).resolve(`${ccusageTarget}/bin/ccusage`);

/** One Codex rollout, in the log format ccusage reads from CODEX_HOME. */
function codexRollout(path, at, model, counts) {
    const usage = { input_tokens: counts.input, cached_input_tokens: counts.cached, output_tokens: counts.output, reasoning_output_tokens: counts.reasoning, total_tokens: counts.input + counts.output };
    writeTranscript(path, [
        JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 'fixture', timestamp: at, cwd: '/tmp', originator: 'muxr-check', cli_version: '1.0.0', instructions: null } }),
        JSON.stringify({ timestamp: at, type: 'turn_context', payload: { model, cwd: '/tmp' } }),
        JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 272_000 } } }),
    ]);
}

const scratch = mkdtempSync(join(tmpdir(), 'muxr-usage-'));
const piMarker = join(scratch, 'pi-ran');
const ccusageMarker = join(scratch, 'ccusage-ran');
const codexMarker = join(scratch, 'codex-ran');
const ccusage = join(scratch, 'ccusage');
const today = new Date('2026-09-05T12:00:00Z');
const day = (offset) => new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);

const report = {
    daily: [
        { period: day(1), agents: [{ agent: 'claude', totalTokens: 400_000, totalCost: 9.5 }, { agent: 'kimi', totalTokens: 60_000 }] },
        {
            period: day(0),
            agents: [
                {
                    agent: 'claude',
                    totalTokens: 1_250_000,
                    inputTokens: 42,
                    totalCost: 123.45,
                    modelBreakdowns: [
                        { modelName: 'claude-opus-5', inputTokens: 42, outputTokens: 1_000, cacheReadTokens: 1_248_958, cacheCreationTokens: 0 },
                    ],
                },
                { agent: 'kimi', totalTokens: 2500 },
                { agent: 'pi', totalTokens: 800 },
                { agent: 'opencode', totalTokens: 300, totalCost: 0 },
                { agent: 'hostile\nname', totalTokens: 999999 },
            ],
        },
    ],
    session: [
        { agent: 'claude', totalTokens: 1250000, metadata: { lastActivity: '2026-09-05T09:00:00Z' } },
        { agent: 'kimi', totalTokens: 2500, metadata: { lastActivity: '2026-09-05T08:00:00Z' } },
        { agent: 'pi', totalTokens: 800, metadata: { lastActivity: '2026-09-05T07:00:00Z' } },
    ],
    totals: { totalTokens: 1_253_300, totalCost: 132.95 },
};
for (const day of report.daily) {
    for (const agent of day.agents) {
        if (!agent.modelBreakdowns) agent.modelBreakdowns = Array.from({ length: 150 }, (_, index) => ({ modelName: `model-${index}`, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 }));
    }
}
assert.ok(Buffer.byteLength(JSON.stringify(report)) > 64 * 1024);

// Reset countdowns use the real clock like the Codex fixture below; only the
// report/calendar dates stay pinned to today.
const claudeLimits = {
    rate_limits: {
        five_hour: { used_percentage: 21, resets_at: Math.floor(Date.now() / 1000) + 3 * 3_600 },
        seven_day: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3 * 86_400 },
    },
};

// The usage collector is a host module now: the check drives the built host
// dist the same way the running host does, mutating the host's own environment
// per scenario and restoring it afterwards.
const { collectUsage, usageNow } = await import('../../../apps/host/dist/usage/index.js');
const { tightestWindow } = await import('../../../apps/host/dist/usage/domain/usageWindows.js');

const ENV_KEYS = ['HOME', 'PATH', 'TZ', 'XDG_DATA_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OPENCODE_DB', 'OPENCODE_DATA_DIR', 'OPENCODE_AUTH_CONTENT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'MUXR_HOME', 'MUXR_CCUSAGE_BIN', 'MUXR_USAGE_NOW', 'MUXR_USAGE_PROVIDER', 'NODE_OPTIONS'];
let fetchStub = undefined;
const realFetch = globalThis.fetch;
async function stubbedFetch(url, options) {
    if (fetchStub !== undefined) return fetchStub(url, options);
    return realFetch(url, options);
}
globalThis.fetch = stubbedFetch;

/** Run one collection against a host environment, then restore everything.
 *  `__fetch` stubs global fetch for plan endpoints instead of touching env. */
async function drive(environment, input) {
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    const previousFetch = fetchStub;
    const { __fetch, ...env } = environment;
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fetchStub = __fetch;
    // The collector reads a frozen snapshot: a collection that keeps running
    // behind usage.now's bounded wait never observes a later restore.
    const frozenEnv = { ...process.env };
    try {
        return await collectUsage(input ?? {}, frozenEnv);
    } finally {
        fetchStub = previousFetch;
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/** One usage.now answer (the Home card path, bounded wait included). */
async function driveNow(environment) {
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    const previousFetch = fetchStub;
    const { __fetch, ...env } = environment;
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fetchStub = __fetch;
    const frozenEnv = { ...process.env };
    try {
        return await usageNow(frozenEnv);
    } finally {
        fetchStub = previousFetch;
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

const baseEnv = () => ({
    HOME: scratch,
    PATH: `${scratch}:${process.env.PATH}`,
    XDG_DATA_HOME: join(scratch, '.local/share'),
    PI_CONFIG_DIR: '.omp',
    OMP_PROFILE: '',
    PI_PROFILE: '',
    CLAUDE_CONFIG_DIR: join(scratch, '.claude'),
    TZ: 'UTC',
    MUXR_USAGE_NOW: today.toISOString(),
    MUXR_HOME: scratch,
    MUXR_CCUSAGE_BIN: ccusage,
    CODEX_HOME: join(scratch, '.codex'),
    // undefined deletes: the disk Go account is the default unless a run pins
    // the OPENCODE_AUTH_CONTENT override itself.
    OPENCODE_AUTH_CONTENT: undefined,
    NODE_OPTIONS: undefined,
    PI_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
});
const run = (input, environment = {}) => drive({ ...baseEnv(), ...environment }, input);
const stateFile = (tab) => join(scratch, 'usage', `usage-v2-${tab}.json`);

try {
    writeTranscript(join(scratch, '.omp/agent/sessions/proj/session.jsonl'), [
        record('omp-1', '2026-09-05T11:00:00.000Z', 'fixture-omp', { input: 100, output: 20, cacheRead: 30 }, 0.01),
    ]);
    mkdirSync(join(scratch, '.local/share/opencode'), { recursive: true });
    seedDatabase(join(scratch, '.local/share/opencode/opencode.db'),
        'CREATE TABLE message (time_created INTEGER, data TEXT)', 'INSERT INTO message VALUES (?, ?)',
        [Date.parse('2026-09-05T10:00:00Z'), JSON.stringify({ role: 'assistant', modelID: 'fixture-go', providerID: 'opencode-go', tokens: { input: 200, output: 40, cache: { read: 60, write: 0 } }, cost: 0 })]);
    writeFileSync(join(scratch, 'pi'), `#!/bin/sh\ntouch "${piMarker}"\nexit 99\n`, { mode: 0o755 });
    writeFileSync(ccusage, `#!/bin/sh\ncase "$1 $2" in\n"daily --by-agent") printf x >> "${ccusageMarker}"; printf '%s' '${JSON.stringify(report)}';;\n*) exit 77;;\nesac\n`, { mode: 0o755 });
    mkdirSync(join(scratch, '.claude'));
    writeFileSync(join(scratch, '.claude', 'last-statusline-input.json'), JSON.stringify(claudeLimits));
    writeFileSync(join(scratch, 'codex'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(codexMarker)}, 'x');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;for(;;){const i=b.indexOf('\\n');if(i<0)break;const line=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:90,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}}}}));}});\n`, { mode: 0o755 });
    for (const command of ['claude', 'kimi', 'opencode', 'hermes', 'github-copilot', 'cursor-agent', 'omp', 'gemini', 'grok', 'amp', 'droid', 'codebuff', 'goose', 'openclaw', 'kilocode', 'qwen', 'devin', 'kiro-cli', 'cline', 'maki', 'mastra', 'qoder', 'antigravity']) writeFileSync(join(scratch, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Default tab: the busiest measured provider leads, and its own windows ride
    // the same view model as the limits card.
    const output = await run({ provider: 'claude' });
    // Only integrated providers earn tabs: measured activity this week or a
    // connected plan/account. The fixture installs many idle CLIs; none of
    // them may mint a tab.
    assert.deepEqual(output.providers.map((p) => p.id), ['omp', 'opencode', 'claude', 'kimi', 'pi', 'codex']);
    // Every tab ships an agent mark id; the app renders bundled marks and
    // falls back to a monogram for the allow-listed rest (today: zai).
    const agentMarks = new Set(readdirSync(join(process.cwd(), 'apps/mobile/sources/assets/agents'))
        .filter((name) => name.endsWith('.png')).map((name) => name.slice(0, -4)));
    const monogramOnly = new Set(['zai']);
    for (const provider of output.providers) {
        assert.ok(provider.glyph === provider.id, `tab ${provider.id} must carry its own mark id`);
        assert.ok(agentMarks.has(provider.glyph) || monogramOnly.has(provider.glyph), `unresolved mark: ${provider.glyph}`);
    }
    assert.doesNotMatch(JSON.stringify(output), /hostile/);
    // Default tab: the busiest measured provider leads.
    assert.equal(output.provider, 'claude');
    const tabs = output.providers.map((tab) => tab.id);
    for (const idle of ['cursor', 'gemini', 'grok', 'hermes', 'copilot', 'kilo', 'kiro', 'agy', 'mastracode', 'qodercli']) assert.ok(!tabs.includes(idle), `${idle} must not earn a tab while idle`);

    // Claude's tab carries today, its models, the week, and the real plan windows.
    assert.equal(output.todayTokens, '1.3M');
    assert.equal(output.todayCost, '$123.45');
    assert.equal(output.modelSeries[0]?.label, 'claude-opus-5');
    // The window is a fixed 7 days ending today, so an idle day cannot slide an
    // older total into today's slot.
    assert.equal(output.weekSeries.length, 7);
    assert.equal(output.weekSeries.at(-1)?.valueLabel, '1.3M');
    // The limits card payload: used shares, spelled-out resets, elapsed anchors.
    assert.equal(output.limits.plan, 'Claude plan');
    assert.equal(output.limits.verdict, 'go');
    assert.deepEqual(output.limits.windows.map((limit) => [limit.label, limit.window, limit.used]), [['5-hour limit', '5h', 21], ['7-day limit', '7d', 42]]);
    assert.ok(output.limits.windows.every((limit) => typeof limit.resetsIn === 'string' && limit.resetsIn !== ''));
    assert.ok(Math.abs(output.limits.windows[0].elapsed - 0.4) < 0.01);
    // The same windows as the plain view model every surface reads.
    assert.deepEqual(output.windows.map((vm) => [vm.provider, vm.windowKind, vm.percentUsed, vm.percentRemaining]), [
        ['claude', 'session', 21, 79],
        ['claude', 'weekly', 42, 58],
    ]);

    // A quiet provider reports zero today rather than its last active day.
    const kimi = await run({ provider: 'kimi' });
    assert.equal(kimi.provider, 'kimi');
    assert.equal(kimi.todayTokens, '2.5K');
    // Days sit at their own date, so the older total stays in the past and today
    // reports its own figure.
    assert.ok(kimi.weekSeries.some((day) => day.valueLabel === '60.0K'), 'older day must keep its total');
    assert.equal(kimi.weekSeries.at(-1)?.valueLabel, '2.5K');
    // A tab whose agent has no plan integration borrows the machine's
    // tightest connected plan (codex 90% used beats claude 42%), so it
    // answers with a real window instead of a false "not connected".
    assert.equal(kimi.limits.plan, 'OpenAI Codex');
    assert.equal(kimi.limits.verdict, 'low');
    assert.deepEqual(kimi.limits.windows.map((limit) => [limit.label, limit.window, limit.used]), [['OpenAI Codex · 168h', '7d', 90], ['OpenAI Codex · 5h', '5h', 25]]);
    assert.equal(kimi.limits.message, undefined);

    // A deep link to an installed-but-idle provider no longer mints a tab;
    // it falls back to the default one instead.
    const cursor = await run({ provider: 'cursor' });
    assert.equal(cursor.provider, 'omp');
    assert.ok(!cursor.providers.some((p) => p.id === 'cursor'));

    // Pi is accounted from its own transcripts: with none on disk the measured
    // answer is nothing, and ccusage's own Pi row never stands in for it.
    const emptyPi = await run({ provider: 'pi' });
    assert.equal(emptyPi.todayTokens, '0');
    assert.equal(emptyPi.weekTokens, '0');
    assert.equal(emptyPi.activityNotice, undefined);

    // One cache entry per tab, so reopening a tab does not rescan.
    const cached = await run({ provider: 'claude' });
    assert.equal(cached.todayTokens, '1.3M');
    assert.equal(readFileSync(ccusageMarker, 'utf8'), 'xxxx', 'per-tab cache did not prevent a duplicate ccusage scan');
    assert.equal(readFileSync(codexMarker, 'utf8'), 'xxxx', 'per-tab cache did not prevent a duplicate Codex app-server');

    // Pi is accounted locally, so a collection that failed must surface on the
    // tab it belongs to: an honest unavailable notice, not a quiet zero.
    writeTranscript(join(scratch, 'broken-pi/sessions/proj/broken.jsonl'), ['{"message":{"role":"assistant","usage":{"input":5']);
    const brokenPi = await run({ provider: 'pi' }, { PI_AGENT_DIR: join(scratch, 'broken-pi'), MUXR_HOME: join(scratch, 'no-cache-pi') });
    assert.equal(brokenPi.todayTokens, '—');
    assert.match(brokenPi.activityNotice ?? '', /could not be measured/);

    const recent = await run({});
    assert.equal(recent.provider, 'omp');
    assert.equal(recent.todayTokens, '150');
    assert.equal(recent.todayCost, '$0.01');
    assert.equal(recent.modelSeries[0]?.label, 'fixture-omp');
    const go = await run({ provider: 'opencode' });
    assert.equal(go.todayTokens, '300');
    assert.equal(go.todayCost, '$0.00');
    assert.match(go.limits.message ?? '', /Go limits unavailable/);
    assert.ok(!existsSync(stateFile('opencode')), 'missing Go limits must not be cached');
    const goStub = (url, options) => {
        if (url !== 'https://opencode.ai/zen/go/v1/usage' || options.redirect !== 'error' || options.headers.authorization !== 'Bearer fixture-secret-key') throw new Error('unexpected quota request');
        return Promise.resolve(new Response(JSON.stringify({ usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map((key, index) => [key, { status: 'ok', percent: 20 + index, resetsAt: new Date(Date.now() + 3600000).toISOString() }])) })));
    };
    writeFileSync(join(scratch, '.local/share/opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-secret-key' } }));
    // A pinned-but-unusable override must not borrow the disk account.
    const override = await run({ provider: 'opencode' }, { OPENCODE_AUTH_CONTENT: '{}', __fetch: goStub });
    assert.match(override.limits.message ?? '', /connect your Go account/, 'valid auth override must not borrow disk key');
    const connected = await run({ provider: 'opencode' }, { __fetch: goStub });
    const connectedGo = connected;
    assert.equal(connectedGo.limits.plan, 'OpenCode Go');
    assert.deepEqual(connectedGo.limits.windows.map((limit) => [limit.label, limit.used]), [['Rolling', 20], ['Weekly', 21], ['Monthly', 22]]);
    // Rolling is documented as five hours, so it carries a length and an
    // elapsed anchor; monthly's anchor is the subscription date, so no length
    // is invented. Every row spells out its reset.
    assert.deepEqual(connectedGo.limits.windows.map((limit) => [limit.window, limit.resetsIn !== undefined]), [['5h', true], ['7d', true], [undefined, true]]);
    assert.equal(connectedGo.limits.windows[2].elapsed, undefined);
    assert.deepEqual(connectedGo.windows.map((vm) => [vm.provider, vm.windowKind, vm.percentUsed, vm.percentRemaining]), [
        ['opencode', 'rolling', 20, 80],
        ['opencode', 'weekly', 21, 79],
        ['opencode', 'monthly', 22, 78],
    ]);
    assert.doesNotMatch(JSON.stringify(connected), /fixture-secret-key/);
    // A changed disk key changes the cache identity, so the answer is
    // re-collected instead of replaying the previous account's limits.
    writeFileSync(join(scratch, '.local/share/opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'different-fixture-key' } }));
    const changedKey = await run({ provider: 'opencode' }, { __fetch: async () => { throw new Error('unexpected quota request'); } });
    assert.match(changedKey.limits.message ?? '', /limits unavailable/, 'disk key change reused cached account limits');
    assert.doesNotMatch(readFileSync(stateFile('claude'), 'utf8'), /fixture-secret-key|different-fixture-key/);

    // Z.ai: the GLM Coding Plan credential Pi holds earns a tab, and its
    // measured activity is the Z.ai-model slice of Pi's own local records --
    // the monitor endpoint fills the windows, the transcripts fill the tokens.
    const zaiAgent = join(scratch, 'zai-agent');
    mkdirSync(zaiAgent, { recursive: true });
    writeFileSync(join(zaiAgent, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'fixture-zai-key' } }));
    writeFileSync(join(zaiAgent, 'models.json'), JSON.stringify({ providers: { zai: { models: [{ id: 'glm-fixture' }] } } }));
    writeTranscript(join(zaiAgent, 'sessions/proj/zai-session.jsonl'), [
        record('zai-1', '2026-09-05T11:30:00.000Z', 'glm-fixture', { input: 300, output: 100, cacheRead: 100 }, 0.7),
        record('zai-2', '2026-09-05T11:45:00.000Z', 'other-model', { input: 50 }, 0.9),
    ]);
    const zaiStubOk = (url, options) => {
        if (url !== 'https://api.z.ai/api/monitor/usage/quota/limit' || options.redirect !== 'error' || options.headers.authorization !== 'Bearer fixture-zai-key') throw new Error('unexpected quota request');
        return Promise.resolve(new Response(JSON.stringify({ code: 200, msg: 'Operation successful', success: true, data: { level: 'pro', limits: [
            { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 539, remaining: 11461, percentage: 4, nextResetTime: Date.now() + 3 * 3600000 },
            { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 539, remaining: 59461, percentage: 1, nextResetTime: Date.now() + 3 * 86400000 },
            { type: 'CREDIT_LIMIT', unit: 9, number: 9, usage: 1, currentValue: 0, remaining: 1, percentage: 200, nextResetTime: Date.now() + 3600000 },
        ] } })));
    };
    const zaiRun = await run({ provider: 'zai' }, { PI_AGENT_DIR: zaiAgent, MUXR_HOME: join(scratch, 'zai-state'), __fetch: zaiStubOk });
    assert.equal(zaiRun.provider, 'zai');
    assert.deepEqual(zaiRun.limits.plan, 'Z.ai plan');
    assert.deepEqual(zaiRun.limits.windows.map((limit) => [limit.label, limit.window, limit.used]), [['5-hour limit', '5h', 4], ['Weekly limit', '7d', 1]]);
    // Tokens are the local Z.ai-model slice: one model, one turn, measured
    // once. Cost stays a dash: plan tokens are priced by the plan, and a
    // recorded dollar figure must never stand in for one.
    assert.equal(zaiRun.todayTokens, '500');
    assert.equal(zaiRun.todayCost, '—');
    assert.equal(zaiRun.weekTokens, '500');
    assert.equal(zaiRun.weekCost, '—');
    assert.equal(zaiRun.activityNotice, undefined);
    assert.deepEqual(zaiRun.modelSeries.map((model) => [model.label, model.value]), [['glm-fixture', 500]]);
    // The windows come out as one plain view model, derived remaining and all.
    assert.deepEqual(zaiRun.windows.map((vm) => [vm.provider, vm.windowKind, vm.percentUsed, vm.percentRemaining, vm.pace.verdict]), [
        ['zai', 'session', 4, 96, 'ahead'],
        ['zai', 'weekly', 1, 99, 'ahead'],
    ]);
    assert.doesNotMatch(JSON.stringify(zaiRun), /fixture-zai-key/);
    // The configured plan is a tab even with zero measured activity of its
    // own, while installed-but-idle CLIs still are not.
    const withZai = await run({}, { PI_AGENT_DIR: zaiAgent, MUXR_HOME: join(scratch, 'zai-state2') });
    assert.ok(withZai.providers.some((p) => p.id === 'zai'));
    assert.ok(!withZai.providers.some((p) => p.id === 'cursor' || p.id === 'gemini'));
    const zaiDenied = await run({ provider: 'zai' }, { PI_AGENT_DIR: zaiAgent, MUXR_HOME: join(scratch, 'zai-state3'), __fetch: async () => new Response('denied', { status: 401 }) });
    assert.match(zaiDenied.limits.message ?? '', /reconnect in Pi/);
    assert.deepEqual(zaiDenied.limits.windows, []);
    const zaiNone = await run({ provider: 'zai' }, { PI_AGENT_DIR: zaiAgent, MUXR_HOME: join(scratch, 'zai-state4'), __fetch: async () => new Response(JSON.stringify({ code: 200, success: false, msg: 'no package' }), { status: 200 }) });
    assert.match(zaiNone.limits.message ?? '', /coding plan unavailable/);
    // A valid dotted profile is isolated from the default; an invalid profile
    // must never quietly read another account's database.
    cpSync(join(scratch, '.omp/agent'), join(scratch, '.omp/profiles/work.team/agent'), { recursive: true });
    const profileEnv = { OMP_PROFILE: 'work.team', MUXR_HOME: join(scratch, 'profile-state') };
    assert.equal((await run({ provider: 'omp' }, profileEnv)).todayTokens, '150');
    const invalidProfile = await run({ provider: 'omp' }, { ...profileEnv, OMP_PROFILE: '../default' });
    assert.match(invalidProfile.activityNotice ?? '', /Invalid OMP profile/);
    assert.equal(invalidProfile.todayTokens, '—');

    // A collector that cannot measure one agent does not stop a healthy tab
    // from caching its own (honestly labelled) payload: the failure stays on
    // screen, and the next open refreshes instead of pinning it.
    rmSync(stateFile('kimi'), { force: true });
    const kimiDuringOmpFailure = await run({ provider: 'kimi' }, { OMP_PROFILE: '../default' });
    assert.equal(kimiDuringOmpFailure.todayTokens, '2.5K');
    assert.ok(existsSync(stateFile('kimi')), 'a healthy tab caches despite another collector failing');
    assert.equal((await run({ provider: 'kimi' })).providers[0]?.id, 'omp');

    // The lag fix: with any last-known payload on disk, the screen paints it
    // at once (flagged stale) instead of holding a skeleton behind a slow
    // collector; the paint itself never runs the collector.
    const kimiCache = stateFile('kimi');
    const seeded = JSON.parse(readFileSync(kimiCache, 'utf8'));
    seeded.at -= 120_000;
    writeFileSync(kimiCache, JSON.stringify(seeded));
    const slowMarker = join(scratch, 'slow-ccusage-ran');
    const slowCcusage = join(scratch, 'ccusage-slow');
    writeFileSync(slowCcusage, `#!/bin/sh\nsleep 6\ntouch "${slowMarker}"\nexit 1\n`, { mode: 0o755 });
    const staleStarted = Date.now();
    const stalePaint = await run({ provider: 'kimi' }, { MUXR_CCUSAGE_BIN: slowCcusage });
    const staleMs = Date.now() - staleStarted;
    assert.equal(stalePaint.todayTokens, '2.5K');
    assert.equal(stalePaint.stale, true);
    assert.ok(staleMs < 5_000, `stale paint waited on its slow collector (${staleMs}ms)`);
    assert.ok(!existsSync(slowMarker), 'stale paint must not run the collector at all');
    // The screen's revalidation asks for fresh data by name (`refresh`), so
    // it re-collects past a still-valid cache and lands clean, flag-free.
    const refreshMarker = join(scratch, 'refresh-ccusage-ran');
    const refreshCcusage = join(scratch, 'ccusage-refresh');
    writeFileSync(refreshCcusage, `#!/bin/sh\ntouch "${refreshMarker}"\nprintf '%s' '${JSON.stringify(report)}'\n`, { mode: 0o755 });
    const refreshed = await run({ provider: 'kimi', refresh: true }, { MUXR_CCUSAGE_BIN: refreshCcusage });
    assert.ok(existsSync(refreshMarker), 'revalidation re-collected past the cache');
    assert.ok(!('stale' in refreshed));
    assert.equal(refreshed.todayTokens, '2.5K');
    rmSync(stateFile('all'), { force: true });
    const codexFixture = readFileSync(join(scratch, 'codex'), 'utf8');
    rmSync(join(scratch, 'codex'));
    const fallback = await run({ provider: 'codex' }, { MUXR_CCUSAGE_BIN: join(scratch, 'missing') });
    // Codex without its CLI earns no tab, so the deep link falls back; the
    // measured-local tab it lands on still answers from its own collector.
    assert.equal(fallback.provider, 'omp');
    assert.equal(fallback.todayTokens, '150');
    assert.ok(!fallback.providers.some((p) => p.id === 'codex'));
    assert.doesNotMatch(JSON.stringify(fallback.windows), /OpenAI Codex/);
    assert.ok(!existsSync(stateFile('codex')));

    const invalid = await run({ provider: 'qwen' }, { MUXR_CCUSAGE_BIN: '/bin/true' });
    assert.equal(invalid.provider, 'omp');
    assert.ok(!invalid.providers.some((p) => p.id === 'qwen'));

    // Daylight saving: the reported window is seven local days, and a
    // spring-forward day cannot drop out of the week.
    const dstScratch = mkdtempSync(join(tmpdir(), 'muxr-usage-dst-'));
    try {
        const dstReport = {
            daily: [
                { period: '2026-03-07', agents: [{ agent: 'claude', totalTokens: 333, totalCost: 1 }] },
                { period: '2026-03-08', agents: [{ agent: 'claude', totalTokens: 111, totalCost: 1 }] },
                { period: '2026-03-09', agents: [{ agent: 'claude', totalTokens: 222, totalCost: 1 }] },
            ],
            totals: { totalTokens: 666, totalCost: 3 },
        };
        const dstCcusage = join(dstScratch, 'ccusage');
        writeFileSync(dstCcusage, `#!/bin/sh\nprintf '%s' '${JSON.stringify(dstReport)}'\n`, { mode: 0o755 });
        writeFileSync(join(dstScratch, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const dstOut = await drive({
            HOME: dstScratch,
            PATH: `${dstScratch}:${process.env.PATH}`,
            MUXR_CCUSAGE_BIN: dstCcusage,
            MUXR_HOME: dstScratch,
            XDG_DATA_HOME: join(dstScratch, '.local/share'), PI_CONFIG_DIR: '.omp',
            TZ: 'America/New_York',
            MUXR_USAGE_NOW: '2026-03-09T04:30:00.000Z',
            OPENCODE_AUTH_CONTENT: undefined, NODE_OPTIONS: undefined,
        }, {});
        assert.equal(dstOut.weekSeries.length, 7);
        assert.equal(dstOut.weekSeries[4]?.valueLabel, '333');
        assert.equal(dstOut.weekSeries[5]?.valueLabel, '111', 'DST spring-forward day dropped from the local week');
        assert.equal(dstOut.weekSeries[6]?.valueLabel, '222');
    } finally {
        rmSync(dstScratch, { recursive: true, force: true });
    }
    process.stdout.write('PASS tabs: per-provider ccusage tabs + safe live limits + deduped local accounting\n');

    // Profile switches and provider env stay host-internal: the same module
    // the running host calls reads the host's own environment, and a switch
    // re-collects instead of replaying another profile's cache.
    const hostRoot = join(scratch, 'host-xdg');
    mkdirSync(join(hostRoot, 'omp/profiles/host.flow'), { recursive: true });
    mkdirSync(join(hostRoot, 'opencode'), { recursive: true });
    writeTranscript(join(hostRoot, 'omp/profiles/host.flow/agent/sessions/proj/session.jsonl'), [
        record('host-1', new Date(Date.now() - 60_000).toISOString(), 'host-omp', { input: 100, output: 20, cacheRead: 30 }, 0.01),
    ]);
    writeFileSync(join(hostRoot, 'opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'must-not-borrow-disk-key' } }));
    // The Go tab needs real integration: a fresh opencode record puts the
    // provider on the strip so its connection state can be asserted below.
    seedDatabase(join(hostRoot, 'opencode/opencode.db'),
        'CREATE TABLE message (time_created INTEGER, data TEXT)', 'INSERT INTO message VALUES (?, ?)',
        [Date.now() - 30_000, JSON.stringify({ role: 'assistant', modelID: 'fixture-go', providerID: 'opencode-go', tokens: { input: 5, output: 5 }, cost: 0 })]);
    writeFileSync(join(scratch, 'codex'), codexFixture, { mode: 0o755 });
    // The host-internal section runs on the real clock like the live host: the
    // transcripts it writes are fresh, so no pinned MUXR_USAGE_NOW here.
    const hostEnvironment = { HOME: scratch, PATH: `${scratch}:${process.env.PATH}`, XDG_DATA_HOME: hostRoot, PI_CONFIG_DIR: '.omp', OMP_PROFILE: 'host.flow', PI_PROFILE: '', CLAUDE_CONFIG_DIR: join(scratch, '.claude'), CODEX_HOME: join(scratch, '.codex'), TZ: 'UTC', MUXR_HOME: scratch, MUXR_CCUSAGE_BIN: ccusage, MUXR_USAGE_NOW: undefined, OPENCODE_AUTH_CONTENT: '{}' };
    const launched = await drive(hostEnvironment, { provider: 'omp' });
    assert.equal(launched.provider, 'omp');
    assert.equal(launched.todayTokens, '150');
    assert.equal(launched.modelSeries[0]?.label, 'host-omp');
    writeTranscript(join(hostRoot, 'omp/profiles/host.next/agent/sessions/proj/session.jsonl'), [
        record('next-1', new Date(Date.now() - 60_000).toISOString(), 'next-omp', { input: 7 }, 0.01),
    ]);
    const switched = await drive({ ...hostEnvironment, OMP_PROFILE: 'host.next' }, { provider: 'omp' });
    assert.equal(switched.todayTokens, '7', 'profile switch reused another profile cache');
    const hostGo = await drive({ ...hostEnvironment, OPENCODE_AUTH_CONTENT: '{}' }, { provider: 'opencode' });
    assert.match(hostGo.limits.message ?? '', /connect your Go account/);
    assert.doesNotMatch(JSON.stringify(hostGo), /must-not-borrow-disk-key/);
    process.stdout.write('PASS host env: profile switches re-collect; the disk Go account is never borrowed\n');

    // Release flow: real transcripts through the real collector, next to the
    // real pinned ccusage reading the same Pi root. Everything below is one
    // journey across tabs at one fixed instant, minutes after Dubai midnight.
    const flow = mkdtempSync(join(tmpdir(), 'muxr-usage-flow-'));
    try {
        const captured = '2026-09-07T20:05:00.000Z'; // 2026-09-08 00:05 in Asia/Dubai
        const piRoot = join(flow, 'pi-agent');
        const original = [
            record('pi-b', '2026-09-07T06:00:00.000Z', 'fixture-pi', { input: 400, output: 100 }, undefined),
            record('pi-a', '2026-09-07T20:02:00.000Z', 'fixture-pi', { input: 900, output: 100 }, 0.5),
        ];
        writeTranscript(join(piRoot, 'sessions/proj/original.jsonl'), original);
        // The fork file copies its parent's messages verbatim and adds its own.
        writeTranscript(join(piRoot, 'sessions/proj/fork.jsonl'), [
            ...original,
            record('pi-c', '2026-09-07T20:04:00.000Z', 'fixture-pi-mini', { input: 200, output: 50 }, 0.25),
        ]);
        const ompRoot = join(flow, '.omp');
        mkdirSync(ompRoot, { recursive: true });
        // A stats database frozen days ago must not outrank the transcripts.
        seedDatabase(join(ompRoot, 'stats.db'),
            'CREATE TABLE messages (timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER, cost_total REAL)',
            'INSERT INTO messages VALUES (?, ?, 0, 0, 0, 0, 999999999, 4242.42)', [Date.parse('2026-09-02T08:00:00Z'), 'stale-omp']);
        writeTranscript(join(ompRoot, 'agent/sessions/proj/session.jsonl'), [
            record('omp-y', '2026-09-07T05:00:00.000Z', 'fixture-omp', { input: 1000, cacheRead: 3000 }, 0),
        ]);
        writeFileSync(join(flow, 'codex'), readFileSync(join(scratch, 'codex'), 'utf8'), { mode: 0o755 });
        // ccusage refuses every agent when CLAUDE_CONFIG_DIR is not a config
        // directory, which would hide the pinned Codex totals below.
        mkdirSync(join(flow, '.claude/projects'), { recursive: true });
        codexRollout(join(flow, '.codex/sessions/2026/09/07/rollout-2026-09-07T20-02-00-a.jsonl'), '2026-09-07T20:02:00.000Z', 'gpt-5-codex', { input: 1000, cached: 200, output: 300, reasoning: 100 });
        codexRollout(join(flow, '.codex/sessions/2026/09/06/rollout-2026-09-06T10-00-00-b.jsonl'), '2026-09-06T10:00:00.000Z', 'gpt-5-codex', { input: 500, cached: 0, output: 200, reasoning: 0 });
        const flowEnv = {
            HOME: flow, PATH: `${flow}:${process.env.PATH}`,
            XDG_DATA_HOME: join(flow, '.local/share'), PI_CONFIG_DIR: '.omp', PI_AGENT_DIR: piRoot,
            OMP_PROFILE: '', PI_PROFILE: '', CLAUDE_CONFIG_DIR: join(flow, '.claude'),
            CODEX_HOME: join(flow, '.codex'), TZ: 'Asia/Dubai', MUXR_USAGE_NOW: captured,
            MUXR_HOME: join(flow, 'state'),
            MUXR_CCUSAGE_BIN: undefined,
            OPENCODE_AUTH_CONTENT: undefined, NODE_OPTIONS: undefined,
        };
        const flowRun = (provider, environment = {}) => drive({ ...flowEnv, ...environment }, { provider });
        mkdirSync(join(flow, 'state'));

        // Upstream ccusage counts the fork's copies again; that is the defect
        // this collector exists to correct, so assert the raw report first.
        const upstream = JSON.parse(spawnSync(ccusageBinary,
            ['daily', '--by-agent', '--sections', 'daily', '--json', '--offline'],
            { encoding: 'utf8', env: { ...process.env, HOME: flow, PI_AGENT_DIR: piRoot, TZ: 'Asia/Dubai' }, timeout: 30_000 }).stdout);
        const upstreamToday = upstream.daily.find((day) => day.period === '2026-09-08')?.agents.find((row) => row.agent === 'pi');
        assert.equal(upstreamToday?.totalTokens, 2250, 'fixture no longer reproduces the fork duplication');

        const pi = await flowRun('pi');
        assert.equal(pi.provider, 'pi');
        assert.equal(pi.capturedAt, captured);
        // 1000 today plus 250 from the fork's own message, each counted once.
        assert.equal(pi.todayTokens, '1.3K');
        assert.equal(pi.weekSeries.at(-1)?.value, 1250);
        assert.equal(pi.todayCost, '$0.75');
        assert.deepEqual(pi.modelSeries.map((model) => [model.label, model.value]), [['fixture-pi', 1000], ['fixture-pi-mini', 250]]);
        // Seven dated bars, today last, and the week is exactly their sum.
        assert.deepEqual(pi.weekSeries.map((day) => day.detail), ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']);
        assert.deepEqual(pi.windowPeriods, pi.weekSeries.map((day) => day.detail));
        assert.equal(pi.weekSeries.reduce((sum, day) => sum + day.value, 0), 1750);
        assert.equal(pi.weekTokens, '1.8K');
        // Yesterday's record has no recorded cost: unknown, never free.
        assert.equal(pi.weekSeries.at(-2)?.value, 500);
        assert.equal(pi.weekCost, '—');
        // The pi tab borrows the machine's tightest connected plan (codex)
        // instead of a false "not connected".
        assert.equal(pi.limits.plan, 'OpenAI Codex');
        assert.equal(pi.limits.verdict, 'low');
        assert.deepEqual(pi.limits.windows.map((limit) => [limit.label, limit.window, limit.used]), [['OpenAI Codex · 168h', '7d', 90], ['OpenAI Codex · 5h', '5h', 25]]);
        assert.equal(pi.limits.message, undefined);

        const omp = await flowRun('omp');
        assert.equal(omp.provider, 'omp');
        // Measured, and measured empty: zero tokens cost zero, not unknown.
        assert.equal(omp.todayTokens, '0');
        assert.equal(omp.todayCost, '$0.00');
        assert.deepEqual(omp.modelSeries, []);
        assert.equal(omp.weekTokens, '4.0K');
        assert.equal(omp.weekCost, '$0.00');
        assert.equal(omp.weekSeries.at(-2)?.value, 4000);
        // A stale row could only surface through measured activity. The
        // borrowed limits node ships no usage records, and its clock-derived
        // elapsed floats legitimately print digit runs like 999999999.
        assert.doesNotMatch(JSON.stringify([omp.modelSeries, omp.weekSeries, omp.weekTokens, omp.weekCost, omp.todayTokens, omp.todayCost]),
            /stale-omp|999999999|4242/, 'stale stats database outranked the transcripts');

        // Real Codex logs through the real ccusage: pinned daily and week totals,
        // not a shape check.
        const codex = await flowRun('codex');
        assert.equal(codex.provider, 'codex');
        assert.ok(codex.limits.windows.length > 0);
        // Every limits row ships a used share inside 0..100 and a spelled-out reset.
        assert.ok(codex.limits.windows.every((limit) => Number.isFinite(limit.used) && limit.used >= 0 && limit.used <= 100 && typeof limit.resetsIn === 'string'));
        // Codex windows ride the same view model: kind from the published
        // length, remaining derived, pace projected against the reset clock.
        assert.deepEqual(codex.windows.map((vm) => [vm.provider, vm.windowKind, vm.percentUsed, vm.percentRemaining, vm.pace.verdict]), [
            ['codex', 'weekly', 90, 10, 'burning'],
            ['codex', 'session', 25, 75, 'ahead'],
        ]);
        assert.equal(codex.todayTokens, '1.3K');
        assert.equal(codex.weekSeries.at(-1)?.value, 1300);
        assert.equal(codex.weekSeries[4]?.value, 700);
        assert.equal(codex.weekTokens, '2.0K');
        assert.equal(codex.todayCost, '$0.00');
        assert.equal(codex.weekCost, '$0.01');
        assert.equal(codex.modelSeries[0]?.label, 'gpt-5-codex');

        // A configured agent directory is the OMP root when no profile is set.
        const custom = join(flow, 'custom-omp');
        writeTranscript(join(custom, 'sessions/proj/session.jsonl'), [
            record('custom-1', '2026-09-07T20:03:00.000Z', 'custom-omp', { input: 55 }, 0.02),
        ]);
        const customRoot = await flowRun('omp', { PI_CODING_AGENT_DIR: custom, MUXR_HOME: join(flow, 'state-custom') });
        assert.equal(customRoot.todayTokens, '55');
        assert.equal(customRoot.modelSeries[0]?.label, 'custom-omp');

        // A usage record that cannot be parsed makes the total unavailable
        // rather than quietly dropping what it was worth.
        const malformed = join(flow, 'malformed-agent');
        writeTranscript(join(malformed, 'sessions/proj/broken.jsonl'), [
            record('good-1', '2026-09-07T20:03:00.000Z', 'fixture-pi', { input: 10 }, 0.01),
            '{"message":{"role":"assistant","usage":{"input":5',
        ]);
        const broken = await flowRun('pi', { PI_AGENT_DIR: malformed, MUXR_HOME: join(flow, 'state-m1') });
        assert.equal(broken.todayTokens, '—');
        assert.match(broken.activityNotice ?? '', /could not be measured/);
        // A transcript nested past the scan's depth bound is unread, not empty.
        const deep = join(flow, 'deep-agent');
        writeTranscript(join(deep, 'sessions/a/b/c/d/e/f/g/h/i/session.jsonl'), [
            record('deep-1', '2026-09-07T20:03:00.000Z', 'fixture-pi', { input: 10 }, 0.01),
        ]);
        assert.equal((await flowRun('pi', { PI_AGENT_DIR: deep, MUXR_HOME: join(flow, 'state-m2') })).todayTokens, '—');

        // Real Pi trees nest by worktree slug, session, subagent, and run —
        // depth the scan has to measure, not refuse.
        const nested = join(flow, 'nested-agent');
        writeTranscript(join(nested, 'sessions/--home-umer-worktree--/2026-09-07_session/sub-1/run-0/session.jsonl'), [
            record('nested-1', '2026-09-07T20:03:00.000Z', 'fixture-pi', { input: 700 }, 0.02),
        ]);
        assert.equal((await flowRun('pi', { PI_AGENT_DIR: nested, MUXR_HOME: join(flow, 'state-m3') })).todayTokens, '700');

        // A line past the 4 MB bound whose usage sits after the retained prefix:
        // the head alone cannot say the line was worthless, so the total is not
        // reported as if the line had been read.
        const oversized = join(flow, 'oversized-agent');
        writeTranscript(join(oversized, 'sessions/proj/wide.jsonl'), [
            record('good-2', '2026-09-07T20:03:00.000Z', 'fixture-pi', { input: 10 }, 0.01),
            `{"id":"huge","pad":"${'p'.repeat(5 * 1024 * 1024)}","message":{"role":"assistant","model":"fixture-pi","timestamp":"2026-09-07T20:03:30.000Z","usage":{"input":999999}}}`,
        ]);
        const huge = await flowRun('pi', { PI_AGENT_DIR: oversized, MUXR_HOME: join(flow, 'state-m4') });
        assert.equal(huge.todayTokens, '—');
        assert.match(huge.activityNotice ?? '', /could not be measured/);

        // A root that is there but cannot be read is not an empty root. Only
        // portable where the process is not root, which ignores the mode.
        if (process.getuid?.() !== 0) {
            const locked = join(flow, 'locked-agent');
            mkdirSync(join(locked, 'sessions/proj'), { recursive: true });
            writeTranscript(join(locked, 'sessions/proj/session.jsonl'), [
                record('locked-1', '2026-09-07T20:03:00.000Z', 'fixture-pi', { input: 10 }, 0.01),
            ]);
            chmodSync(join(locked, 'sessions/proj'), 0o000);
            try {
                const denied = await flowRun('pi', { PI_AGENT_DIR: locked, MUXR_HOME: join(flow, 'state-m5') });
                assert.equal(denied.todayTokens, '—');
                assert.match(denied.activityNotice ?? '', /could not be measured/);
            } finally { chmodSync(join(locked, 'sessions/proj'), 0o755); }
        }

        // Back to Pi: the same journey twice reports the same figures.
        const again = await flowRun('pi');
        assert.equal(again.provider, 'pi');
        assert.equal(again.todayTokens, '1.3K');
        assert.equal(again.weekCost, '—');

        // Authoritative collection that cannot complete says so; it never shows
        // a truncated total, and never caches one.
        const exhausted = join(flow, 'exhausted-agent');
        writeTranscript(join(exhausted, 'sessions/proj/wide.jsonl'),
            Array.from({ length: 1100 }, (_, index) => record(`wide-${index}`, '2026-09-07T20:03:00.000Z', `model-${index}`, { input: 10 }, 0.01)));
        rmSync(join(flow, 'state', 'usage-v2-pi.json'), { force: true });
        const unavailable = await flowRun('pi', { PI_AGENT_DIR: exhausted });
        assert.equal(unavailable.todayTokens, '—');
        assert.equal(unavailable.todayCost, '—');
        assert.match(unavailable.activityNotice ?? '', /could not be measured/);
        assert.ok(!existsSync(join(flow, 'state', 'usage-v2-pi.json')), 'unavailable collection was cached');
    } finally {
        rmSync(flow, { recursive: true, force: true });
    }
    process.stdout.write('PASS flow: fork-deduped transcripts, borrowed plans, bounded scans, Dubai-midnight journey\n');

    // The Right now card leads with the window the verdict describes: the
    // highest share used, ties to the first published. Compared against the
    // same Usage answer usage.now read, so a selection that picked another
    // window -- or none -- fails here. Runs after the scan-counting
    // assertions: usage.now answers from the same cache one ccusage scan fills.
    // usage.now never names a provider -- it always collects the default view
    // -- so the default selection decides the payload, and in this fixture
    // that is `omp`, which publishes no plan windows at all. Seed the `all`
    // cache both readers below will hit with the Claude answer, whose fixture
    // publishes a competing 5-hour and 7-day window, so there is something to
    // select between. MUXR_USAGE_NOW pins NOW, so the seeded entry is age 0
    // and is served fresh rather than flagged stale.
    const claudeRun = await run({ provider: 'claude' });
    assert.equal(claudeRun.provider, 'claude');
    cpSync(stateFile('claude'), stateFile('all'));
    const nowPayload = await driveNow(baseEnv());
    const nowUsage = await run({});
    assert.equal(nowUsage.provider, 'claude', 'the seeded cache must be what both readers answered from');
    assert.ok(!('stale' in nowUsage), 'a cache seeded at the pinned NOW must be served fresh');
    assert.ok(nowUsage.windows.length > 1, 'fixtures must publish competing windows for the selection to mean anything');
    assert.equal(nowPayload.limits.verdict, nowUsage.limits.verdict);
    // The card must lead with the same window `limitsPayload` derived the
    // verdict from -- run that one selection over the same view models the
    // usage payload published. Which window was selected, not object
    // identity: both runs rebuild from their own `Date.now()`, so `elapsed` is
    // a live float that only a cache-served second run would match whole.
    const led = nowPayload.limits.windows[0];
    const describes = nowUsage.limits.windows[nowUsage.windows.indexOf(tightestWindow(nowUsage.windows))];
    assert.ok(led !== undefined && describes !== undefined, 'the card must lead with a window');
    assert.deepEqual(
        { label: led.label, used: led.used, window: led.window },
        { label: describes.label, used: describes.used, window: describes.window },
        'the card must lead with the window the verdict describes',
    );
    assert.ok(Number.isFinite(nowPayload.vitals.memoryTotal) && nowPayload.vitals.memoryTotal > 0);
    assert.ok(Number.isFinite(nowPayload.vitals.load1) && Number.isFinite(nowPayload.vitals.uptimeSeconds));
    // The disk pair is the one figure a host may not be able to read: a denied
    // statfs drops it and leaves the rest of the line standing. Absent is the
    // contract; present-but-zero would divide the share by zero.
    assert.ok(nowPayload.vitals.diskTotal === undefined
        || (Number.isFinite(nowPayload.vitals.diskTotal) && nowPayload.vitals.diskTotal > 0));
    // The connected strip passes through verbatim: every provider with real
    // quota windows, most urgent first, one entry per window.
    assert.ok(Array.isArray(nowPayload.connected) && nowPayload.connected.length > 0);
    assert.deepEqual(nowPayload.connected.map((entry) => [entry.id, entry.windows.length]), [['codex', 2], ['claude', 2]]);
    // The cold-cache fallback, driven through the real usage.now path: a
    // usage read that cannot answer within its bounded wait still leaves the
    // vitals line standing, and says it is collecting rather than reporting a
    // limit it never read.
    const slowCold = join(scratch, 'ccusage-cold');
    const coldMarker = join(scratch, 'cold-ccusage-ran');
    writeFileSync(slowCold, `#!/bin/sh\nsleep 9\ntouch "${coldMarker}"\nexit 1\n`, { mode: 0o755 });
    const coldHome = join(scratch, 'now-cold');
    const coldStarted = Date.now();
    const coldNow = await driveNow({ ...baseEnv(), HOME: coldHome, MUXR_HOME: coldHome, MUXR_CCUSAGE_BIN: slowCold });
    const coldMs = Date.now() - coldStarted;
    assert.equal(coldNow.collecting, true, 'a usage read that cannot answer in time must report collecting');
    assert.deepEqual(coldNow.limits, { verdict: 'unknown', windows: [] });
    assert.ok(Number.isFinite(coldNow.vitals.memoryTotal) && coldNow.vitals.memoryTotal > 0);
    assert.ok(coldMs < 8_000, `the bounded wait answered late (${coldMs}ms)`);
    assert.ok(!existsSync(join(coldHome, 'usage')), 'a timed-out collection must not have cached a partial answer');
    process.stdout.write('PASS now: the home card leads with the window its verdict describes\n');
} finally {
    globalThis.fetch = realFetch;
    rmSync(scratch, { recursive: true, force: true });
}
