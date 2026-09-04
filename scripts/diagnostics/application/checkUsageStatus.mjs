import assert from 'node:assert/strict';
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {};
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

const claudeLimits = {
    rate_limits: {
        five_hour: { used_percentage: 21, resets_at: Math.floor((today.getTime() + 3 * 3_600_000) / 1000) },
        seven_day: { used_percentage: 42, resets_at: Math.floor((today.getTime() + 3 * 86_400_000) / 1000) },
    },
};

const run = (input, environment = {}) => spawnSync(process.execPath, ['plugins/status/usage.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, HOME: scratch, XDG_DATA_HOME: join(scratch, '.local/share'), PI_CONFIG_DIR: '.omp', OMP_PROFILE: '', PI_PROFILE: '', OPENCODE_AUTH_CONTENT: '', CLAUDE_CONFIG_DIR: join(scratch, '.claude'), TZ: 'UTC', MUXR_USAGE_NOW: today.toISOString(), PATH: `${scratch}:${process.env.PATH}`, MUXR_CCUSAGE_BIN: ccusage, MUXR_PLUGIN_STATE_DIR: scratch, ...environment },
    timeout: 20_000,
});

try {
    mkdirSync(join(scratch, '.omp'), { recursive: true });
    seedDatabase(join(scratch, '.omp/stats.db'),
        'CREATE TABLE messages (timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER, cost_total REAL)',
        'INSERT INTO messages VALUES (?, ?, 100, 20, 30, 0, 150, 0.01)', [Date.parse('2026-09-05T11:00:00Z'), 'fixture-omp']);
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

    // Default tab: the busiest measured provider leads, and the card keeps its rows.
    const result = run({ provider: 'claude' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const activity = Object.fromEntries(output.items.filter((item) => item.id.startsWith('activity-')).map((item) => [item.title, item.metadata[0]?.value]));
    assert.deepEqual(activity, { 'Anthropic Claude': '1.3M tokens', 'Kimi Code': '2.5K tokens', Pi: '800 tokens', OpenCode: '300 tokens', OMP: '150 tokens' });
    assert.ok(output.items.some((item) => item.id === 'limit-codex-0' && item.metadata[0]?.value === '75% left' && item.group === 'Rate limits'));
    assert.ok(output.items.some((item) => item.id === 'limit-codex-1' && item.metadata[0]?.value === '10% left'));
    assert.equal(output.codexRemaining, 10);
    assert.ok(output.providers.length > 16);
    for (const agent of ['copilot', 'kilo', 'kiro', 'agy', 'mastracode', 'qodercli']) assert.ok(output.providers.some((p) => p.id === agent));
    assert.equal(output.badge?.value, '1.3M tokens today');

    // Every detected provider earns a tab, measured ones first.
    assert.equal(output.provider, 'claude');
    assert.deepEqual(output.providers.slice(0, 3).map((p) => p.id), ['omp', 'opencode', 'claude']);
    const tabs = output.providers.map((tab) => tab.id);
    for (const expected of ['claude', 'kimi', 'pi', 'codex', 'cursor']) assert.ok(tabs.includes(expected), `missing ${expected} tab`);

    // Claude's tab carries today, its models, the week, and the real plan windows.
    assert.equal(output.todayTokens, '1.3M');
    assert.equal(output.todayCost, '$123');
    assert.equal(output.modelSeries[0]?.label, 'claude-opus-5');
    // The window is a fixed 7 days ending today, so an idle day cannot slide an
    // older total into today's slot.
    assert.equal(output.weekSeries.length, 7);
    assert.equal(output.weekSeries.at(-1)?.valueLabel, '1.3M');
    assert.equal(output.limitLabel, 'Claude plan usage');
    assert.equal(output.fiveHourUsed, 21);
    assert.match(output.fiveHourLabel, /^21% used · resets in /);
    assert.equal(output.sevenDayUsed, 42);
    assert.match(output.sevenDayLabel, /^42% used · resets in /);
    assert.deepEqual(output.limitRing, []);

    // A quiet provider reports zero today rather than its last active day.
    const kimi = JSON.parse(run({ provider: 'kimi' }).stdout);
    assert.equal(kimi.provider, 'kimi');
    assert.equal(kimi.todayTokens, '2.5K');
    // Days sit at their own date, so the older total stays in the past and today
    // reports its own figure.
    assert.ok(kimi.weekSeries.some((day) => day.valueLabel === '60.0K'), 'older day must keep its total');
    assert.equal(kimi.weekSeries.at(-1)?.valueLabel, '2.5K');
    assert.equal(kimi.limitLabel, 'Plan limits unsupported for this provider');

    // An installed but unmeasured provider still opens, empty and honest.
    const cursor = JSON.parse(run({ provider: 'cursor' }).stdout);
    assert.equal(cursor.provider, 'cursor');
    assert.equal(cursor.todayTokens, '—');
    assert.match(cursor.activityLabel, /unsupported/);
    assert.equal(cursor.weekCost, '—');
    assert.deepEqual(cursor.modelSeries, []);

    assert.doesNotMatch(result.stdout, /hostile/);
    // Rows open the details screen and nothing else: the card is a summary of
    // the same screen, not a second place that shows usage its own way.
    assert.ok(
        output.items.every((item) => item.action === undefined || item.action.type === 'screen' && item.action.contributionId === 'usage.details'),
        'Usage rows reach past their own details screen',
    );
    assert.equal(output.items.find((item) => item.id === 'activity-kimi')?.action?.params?.provider, 'kimi');
    assert.equal(output.actions[0]?.action?.contributionId, 'usage.details');
    assert.ok(existsSync(ccusageMarker), 'Usage plugin did not invoke its pinned ccusage backend');
    assert.ok(!existsSync(piMarker), 'Usage plugin invoked Pi and could enter a paid model path');

    // One cache entry per tab, so reopening a tab does not rescan.
    const cached = run({ provider: 'claude' });
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(JSON.parse(cached.stdout).todayTokens, '1.3M');
    assert.equal(readFileSync(ccusageMarker, 'utf8'), 'xxx', 'per-tab cache did not prevent a duplicate ccusage scan');
    assert.equal(readFileSync(codexMarker, 'utf8'), 'xxx', 'per-tab cache did not prevent a duplicate Codex app-server');

    const recent = JSON.parse(run({}).stdout);
    assert.equal(recent.provider, 'omp');
    assert.equal(recent.todayTokens, '150');
    assert.equal(recent.todayCost, '$0.01');
    assert.equal(recent.modelSeries[0]?.label, 'fixture-omp');
    const go = JSON.parse(run({ provider: 'opencode' }).stdout);
    assert.equal(go.todayTokens, '300');
    assert.equal(go.todayCost, '$0.00');
    assert.match(go.limitLabel, /Go limits unavailable/);
    assert.ok(!existsSync(join(scratch, 'usage-v2-opencode.json')), 'missing Go limits must not be cached');
    writeFileSync(join(scratch, '.local/share/opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-secret-key' } }));
    const goFetch = join(scratch, 'go-fetch.mjs');
    writeFileSync(goFetch, `globalThis.fetch = async (url, options) => {
      if (url !== 'https://opencode.ai/zen/go/v1/usage' || options.redirect !== 'error' || options.headers.authorization !== 'Bearer fixture-secret-key') throw new Error('unexpected quota request');
      return new Response(JSON.stringify({usage:Object.fromEntries(['rolling','weekly','monthly'].map((key,index)=>[key,{status:'ok',percent:20+index,resetsAt:new Date(Date.now()+3600000).toISOString()}]))}));
    };`);
    const goEnv = { NODE_OPTIONS: `--import=${goFetch}`, OPENCODE_AUTH_CONTENT: '{}' };
    const override = JSON.parse(run({ provider: 'opencode' }, goEnv).stdout);
    assert.match(override.limitLabel, /connect your Go account/, 'valid auth override must not borrow disk key');
    const connected = run({ provider: 'opencode' }, { ...goEnv, OPENCODE_AUTH_CONTENT: '' });
    const connectedGo = JSON.parse(connected.stdout);
    assert.equal(connectedGo.limitLabel, 'OpenCode Go plan usage');
    assert.deepEqual(connectedGo.limitSeries.map((limit) => limit.value), [20, 21, 22]);
    assert.doesNotMatch(connected.stdout, /fixture-secret-key/);
    assert.match(JSON.parse(run({ provider: 'opencode' }, goEnv).stdout).limitLabel, /connect your Go account/, 'auth override change reused cached account limits');
    writeFileSync(join(scratch, '.local/share/opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'different-fixture-key' } }));
    assert.match(JSON.parse(run({ provider: 'opencode' }, { ...goEnv, OPENCODE_AUTH_CONTENT: '' }).stdout).limitLabel, /limits unavailable/, 'disk key change reused cached account limits');
    assert.doesNotMatch(readFileSync(join(scratch, 'usage-v2-opencode.json'), 'utf8'), /fixture-secret-key|different-fixture-key/);
    // A valid dotted profile is isolated from the default; an invalid profile
    // must never quietly read another account's database.
    mkdirSync(join(scratch, '.omp/profiles/work.team'), { recursive: true });
    copyFileSync(join(scratch, '.omp/stats.db'), join(scratch, '.omp/profiles/work.team/stats.db'));
    const profileEnv = { OMP_PROFILE: 'work.team', MUXR_PLUGIN_STATE_DIR: '' };
    assert.equal(JSON.parse(run({ provider: 'omp' }, profileEnv).stdout).todayTokens, '150');
    const invalidProfile = JSON.parse(run({ provider: 'omp' }, { ...profileEnv, OMP_PROFILE: '../default' }).stdout);
    assert.match(invalidProfile.activityLabel, /Invalid OMP profile/);
    assert.equal(invalidProfile.todayTokens, '—');

    // A failure in an unselected provider cannot be cached into a healthy tab.
    rmSync(join(scratch, 'usage-v2-kimi.json'));
    copyFileSync(join(scratch, '.omp/stats.db'), join(scratch, 'omp-backup.db'));
    writeFileSync(join(scratch, '.omp/stats.db'), 'broken');
    assert.equal(JSON.parse(run({ provider: 'kimi' }).stdout).todayTokens, '2.5K');
    assert.ok(!existsSync(join(scratch, 'usage-v2-kimi.json')));
    copyFileSync(join(scratch, 'omp-backup.db'), join(scratch, '.omp/stats.db'));
    assert.equal(JSON.parse(run({ provider: 'kimi' }).stdout).providers[0]?.id, 'omp');
    rmSync(join(scratch, 'usage-v2-all.json'));
    const codexFixture = readFileSync(join(scratch, 'codex'), 'utf8');
    rmSync(join(scratch, 'codex'));
    const fallback = run({ provider: 'codex' }, { PATH: scratch, MUXR_CCUSAGE_BIN: join(scratch, 'missing') });
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackOutput = JSON.parse(fallback.stdout);
    assert.equal(fallbackOutput.provider, 'codex');
    assert.equal(fallbackOutput.todayTokens, '—');
    assert.match(fallbackOutput.activityLabel, /unavailable/);
    assert.match(fallbackOutput.limitLabel, /unavailable/);
    assert.ok(!existsSync(join(scratch, 'usage-v2-codex.json')));
    assert.ok(fallbackOutput.items.some((item) => item.id === 'ccusage-unavailable'));
    assert.ok(fallbackOutput.items.some((item) => item.id === 'available-claude' && item.metadata.length === 0));
    assert.doesNotMatch(fallback.stdout, /OpenAI Codex current limit/);
    assert.ok(!existsSync(piMarker), 'Fallback Usage invoked Pi');

    const invalid = run({ provider: 'qwen' }, { PATH: scratch, MUXR_CCUSAGE_BIN: '/bin/true' });
    const invalidOutput = JSON.parse(invalid.stdout);
    assert.equal(invalidOutput.provider, 'qwen');
    assert.match(invalidOutput.activityLabel, /unavailable/);

    const dstScratch = mkdtempSync(join(tmpdir(), 'muxr-usage-dst-'));
    try {
        const dstCcusage = join(dstScratch, 'ccusage');
        const dstReport = {
            daily: [
                { period: '2026-03-07', agents: [{ agent: 'claude', totalTokens: 333, totalCost: 1 }] },
                { period: '2026-03-08', agents: [{ agent: 'claude', totalTokens: 111, totalCost: 1 }] },
                { period: '2026-03-09', agents: [{ agent: 'claude', totalTokens: 222, totalCost: 1 }] },
            ],
            totals: { totalTokens: 666, totalCost: 3 },
        };
        writeFileSync(dstCcusage, `#!/bin/sh\nprintf '%s' '${JSON.stringify(dstReport)}'\n`, { mode: 0o755 });
        writeFileSync(join(dstScratch, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const dst = spawnSync(process.execPath, ['plugins/status/usage.mjs'], {
            cwd: process.cwd(),
            encoding: 'utf8',
            input: '{}',
            env: {
                ...process.env,
                HOME: dstScratch,
                PATH: `${dstScratch}:${process.env.PATH}`,
                MUXR_CCUSAGE_BIN: dstCcusage,
                MUXR_PLUGIN_STATE_DIR: dstScratch,
                XDG_DATA_HOME: join(dstScratch, '.local/share'), PI_CONFIG_DIR: '.omp',
                TZ: 'America/New_York',
                MUXR_USAGE_NOW: '2026-03-09T04:30:00.000Z',
            },
            timeout: 20_000,
        });
        assert.equal(dst.status, 0, dst.stderr);
        const dstOut = JSON.parse(dst.stdout);
        assert.equal(dstOut.weekSeries.length, 7);
        assert.equal(dstOut.weekSeries[4]?.valueLabel, '333');
        assert.equal(dstOut.weekSeries[5]?.valueLabel, '111', 'DST spring-forward day dropped from the local week');
        assert.equal(dstOut.weekSeries[6]?.valueLabel, '222');
    } finally {
        rmSync(dstScratch, { recursive: true, force: true });
    }
    // Real host boundary: a custom profile and Go account override reach only
    // the installed bundled Usage script, through stdin rather than generic env.
    const { runPluginProcess } = await import('../../../apps/host/dist/agent/infrastructure/pluginCatalog.js');
    const hostRoot = join(scratch, 'host-xdg');
    mkdirSync(join(hostRoot, 'omp/profiles/host.flow'), { recursive: true });
    mkdirSync(join(hostRoot, 'opencode'), { recursive: true });
    seedDatabase(join(hostRoot, 'omp/profiles/host.flow/stats.db'),
        'CREATE TABLE messages (timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER, cost_total REAL)',
        'INSERT INTO messages VALUES (?, ?, 100, 20, 30, 0, 150, 0.01)', [Date.now() - 60_000, 'host-omp']);
    writeFileSync(join(hostRoot, 'opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'must-not-borrow-disk-key' } }));
    writeFileSync(join(scratch, 'codex'), codexFixture, { mode: 0o755 });
    mkdirSync(join(scratch, 'host-state'));
    const hostEnvironment = { HOME: scratch, PATH: `${scratch}:${process.env.PATH}`, XDG_DATA_HOME: hostRoot, PI_CONFIG_DIR: '.omp', OMP_PROFILE: 'host.flow', PI_PROFILE: '', OPENCODE_AUTH_CONTENT: '{}', CLAUDE_CONFIG_DIR: join(scratch, '.claude'), CODEX_HOME: join(scratch, '.codex') };
    const previous = Object.fromEntries(Object.keys(hostEnvironment).map((key) => [key, process.env[key]]));
    try {
        Object.assign(process.env, hostEnvironment);
        const call = (script, provider) => runPluginProcess({ pluginId: 'muxr.status', method: 'usage', script, serializedInput: JSON.stringify({ provider, _usageConfig: { OMP_PROFILE: 'caller-must-not-win' } }), stateDir: join(scratch, 'host-state') });
        const launched = await call(resolve('plugins/status/usage.mjs'), 'omp');
        assert.equal(launched.provider, 'omp');
        assert.equal(launched.todayTokens, '150');
        assert.equal(launched.modelSeries[0]?.label, 'host-omp');
        mkdirSync(join(hostRoot, 'omp/profiles/host.next'), { recursive: true });
        seedDatabase(join(hostRoot, 'omp/profiles/host.next/stats.db'),
            'CREATE TABLE messages (timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER, cost_total REAL)',
            'INSERT INTO messages VALUES (?, ?, 7, 0, 0, 0, 7, 0.01)', [Date.now() - 60_000, 'next-omp']);
        process.env.OMP_PROFILE = 'host.next';
        const switched = await call(resolve('plugins/status/usage.mjs'), 'omp');
        assert.equal(switched.todayTokens, '7', 'profile switch reused another profile cache');
        const hostGo = await call(resolve('plugins/status/usage.mjs'), 'opencode');
        assert.match(hostGo.limitLabel, /connect your Go account/);
        assert.doesNotMatch(JSON.stringify(hostGo), /must-not-borrow-disk-key|_usageConfig/);
        const untrusted = join(scratch, 'usage.mjs');
        writeFileSync(untrusted, `import{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({hostAuthInInput:input._usageConfig?.goAuthOverride!==undefined,hostAuthInEnv:process.env.OPENCODE_AUTH_CONTENT!==undefined,hostProfileInEnv:process.env.OMP_PROFILE!==undefined}));`);
        const denied = await call(untrusted, 'omp');
        assert.deepEqual({ ...denied }, { hostAuthInInput: false, hostAuthInEnv: false, hostProfileInEnv: false });
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
    process.stdout.write('PASS e2e: per-provider ccusage tabs + safe live limits\n');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
