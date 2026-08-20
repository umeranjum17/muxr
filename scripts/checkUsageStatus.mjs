import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-usage-'));
const piMarker = join(scratch, 'pi-ran');
const ccusageMarker = join(scratch, 'ccusage-ran');
const codexMarker = join(scratch, 'codex-ran');
const ccusage = join(scratch, 'ccusage');
const today = new Date();
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
                { agent: 'hostile\nname', totalTokens: 999999 },
            ],
        },
    ],
    totals: { totalTokens: 1_253_300, totalCost: 132.95 },
};
const activeBlock = {
    blocks: [{
        isActive: true,
        startTime: new Date(today.getTime() - 3_600_000).toISOString(),
        endTime: new Date(today.getTime() + 3 * 3_600_000).toISOString(),
        burnRate: { tokensPerMinute: 12_000 },
    }],
};

const run = (input, environment = {}) => spawnSync(process.execPath, ['plugins/status/usage.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, MUXR_CCUSAGE_BIN: ccusage, MUXR_PLUGIN_STATE_DIR: scratch, ...environment },
    timeout: 20_000,
});

try {
    writeFileSync(join(scratch, 'pi'), `#!/bin/sh\ntouch "${piMarker}"\nexit 99\n`, { mode: 0o755 });
    writeFileSync(ccusage, `#!/bin/sh\ncase "$1 $2" in\n"daily --by-agent") printf x >> "${ccusageMarker}"; printf '%s' '${JSON.stringify(report)}';;\n"blocks --active") printf '%s' '${JSON.stringify(activeBlock)}';;\n*) exit 77;;\nesac\n`, { mode: 0o755 });
    writeFileSync(join(scratch, 'codex'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(codexMarker)}, 'x');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;for(;;){const i=b.indexOf('\\n');if(i<0)break;const line=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,resetsAt:Math.floor(Date.now()/1000)+3600}}}}}));}});\n`, { mode: 0o755 });
    for (const command of ['claude', 'kimi', 'opencode', 'hermes', 'copilot', 'cursor-agent', 'omp', 'gemini', 'grok']) writeFileSync(join(scratch, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Default tab: the busiest measured provider leads, and the card keeps its rows.
    const result = run({});
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const activity = Object.fromEntries(output.items.filter((item) => item.id.startsWith('activity-')).map((item) => [item.title, item.metadata[0]?.value]));
    assert.deepEqual(activity, { 'Anthropic Claude': '1.3M tokens', 'Kimi Code': '2.5K tokens', Pi: '800 tokens' });
    assert.ok(output.items.some((item) => item.id === 'limit-codex-0' && item.metadata[0]?.value === '75% left' && item.group === 'Rate limits'));
    assert.equal(output.badge?.value, '1.3M tokens today');

    // Every detected provider earns a tab, measured ones first.
    assert.equal(output.provider, 'claude');
    assert.equal(output.providers[0]?.label, 'Anthropic Claude');
    const tabs = output.providers.map((tab) => tab.id);
    for (const expected of ['claude', 'kimi', 'pi', 'codex', 'cursor']) assert.ok(tabs.includes(expected), `missing ${expected} tab`);

    // Claude's tab carries today, its models, the week, and the live 5-hour window.
    assert.equal(output.todayTokens, '1.3M');
    assert.equal(output.todayCost, '$123');
    assert.equal(output.modelSeries[0]?.label, 'claude-opus-5');
    assert.equal(output.weekSeries.length, 2);
    assert.equal(output.weekSeries[1]?.valueLabel, '1.3M');
    assert.match(output.limitLabel, /5-hour window/);
    assert.equal(output.limitRing[0]?.label, 'Left');

    // A quiet provider reports zero today rather than its last active day.
    const kimi = JSON.parse(run({ provider: 'kimi' }).stdout);
    assert.equal(kimi.provider, 'kimi');
    assert.equal(kimi.todayTokens, '2.5K');
    assert.equal(kimi.weekSeries[0]?.valueLabel, '60.0K');
    assert.equal(kimi.limitLabel, '');

    // An installed but unmeasured provider still opens, empty and honest.
    const cursor = JSON.parse(run({ provider: 'cursor' }).stdout);
    assert.equal(cursor.provider, 'cursor');
    assert.equal(cursor.todayTokens, '0');
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
    const cached = run({});
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(JSON.parse(cached.stdout).todayTokens, '1.3M');
    assert.equal(readFileSync(ccusageMarker, 'utf8'), 'xxx', 'per-tab cache did not prevent a duplicate ccusage scan');
    assert.equal(readFileSync(codexMarker, 'utf8'), 'xxx', 'per-tab cache did not prevent a duplicate Codex app-server');

    rmSync(join(scratch, 'usage-all.json'));
    rmSync(join(scratch, 'codex'));
    const fallback = run({}, { PATH: scratch, MUXR_CCUSAGE_BIN: join(scratch, 'missing') });
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackOutput = JSON.parse(fallback.stdout);
    assert.ok(fallbackOutput.items.some((item) => item.id === 'ccusage-unavailable'));
    assert.ok(fallbackOutput.items.some((item) => item.id === 'available-claude' && item.metadata.length === 0));
    assert.doesNotMatch(fallback.stdout, /OpenAI Codex current limit|Local activity today/);
    assert.ok(!existsSync(piMarker), 'Fallback Usage invoked Pi');
    process.stdout.write('PASS e2e: per-provider ccusage tabs + safe live limits\n');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
