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
try {
    writeFileSync(join(scratch, 'pi'), `#!/bin/sh\ntouch "${piMarker}"\nexit 99\n`, { mode: 0o755 });
    writeFileSync(ccusage, `#!/bin/sh\n[ "$*" = "daily --last 1 --by-agent --json --no-cost --offline" ] || exit 77\nprintf x >> "${ccusageMarker}"\nprintf '%s' '${JSON.stringify({
        daily: [{ date: '2026-08-17', agents: [
            { agent: 'claude', totalTokens: 1_250_000, inputTokens: 42, totalCost: 123.45 },
            { agent: 'kimi', totalTokens: 2500 },
            { agent: 'pi', totalTokens: 800 },
            { agent: 'hostile\\nname', totalTokens: 999999 },
        ] }],
        totals: { totalTokens: 1_253_300, totalCost: 123.45 },
    })}'\n`, { mode: 0o755 });
    writeFileSync(join(scratch, 'codex'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(codexMarker)}, 'x');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;for(;;){const i=b.indexOf('\\n');if(i<0)break;const line=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,resetsAt:Math.floor(Date.now()/1000)+3600}}}}}));}});\n`, { mode: 0o755 });
    for (const command of ['claude', 'kimi', 'opencode', 'hermes', 'copilot', 'cursor-agent', 'omp', 'gemini', 'grok']) writeFileSync(join(scratch, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, ['plugins/usage-status/rpc.mjs'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, MUXR_CCUSAGE_BIN: ccusage, MUXR_PLUGIN_STATE_DIR: scratch }, timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const activity = Object.fromEntries(output.items.filter((item) => item.id.startsWith('activity-')).map((item) => [item.title, item.metadata[0]?.value]));
    assert.deepEqual(activity, { 'Anthropic Claude': '1.3M tokens', 'Kimi Code': '2.5K tokens', Pi: '800 tokens' });
    assert.ok(output.items.some((item) => item.id === 'limit-codex-0' && item.metadata[0]?.value === '75% left'));
    const installed = Object.fromEntries(output.items.filter((item) => item.id.startsWith('available-')).map((item) => [item.title, item.subtitle]));
    assert.equal(installed.OpenCode, 'No activity reported by ccusage today');
    assert.equal(installed['Hermes Agent'], 'No activity reported by ccusage today');
    assert.equal(installed['GitHub Copilot CLI'], 'No activity reported by ccusage today');
    assert.equal(installed.Cursor, 'Local totals unsupported by ccusage');
    assert.equal(installed.OMP, 'Local totals unsupported by ccusage');
    assert.equal(installed['Gemini CLI'], 'No activity reported by ccusage today');
    assert.equal(installed['xAI Grok'], 'No activity reported by ccusage today');
    assert.doesNotMatch(result.stdout, /123\.45|totalCost|inputTokens|hostile/);
    assert.ok(!output.items.some((item) => item.id === 'available-claude'));
    assert.ok(output.items.every((item) => item.action === undefined), 'read-only Usage rows unexpectedly expose actions');
    assert.ok(existsSync(ccusageMarker), 'Usage plugin did not invoke its pinned ccusage backend');
    assert.ok(!existsSync(piMarker), 'Usage plugin invoked Pi and could enter a paid model path');
    const cached = spawnSync(process.execPath, ['plugins/usage-status/rpc.mjs'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, MUXR_CCUSAGE_BIN: ccusage, MUXR_PLUGIN_STATE_DIR: scratch }, timeout: 20_000,
    });
    assert.equal(cached.status, 0, cached.stderr);
    assert.ok(JSON.parse(cached.stdout).items.some((item) => item.id === 'activity-claude'));
    assert.equal(readFileSync(ccusageMarker, 'utf8'), 'x', 'one-minute cache did not prevent a duplicate ccusage scan');
    assert.equal(readFileSync(codexMarker, 'utf8'), 'x', 'one-minute cache did not prevent a duplicate Codex app-server');

    rmSync(join(scratch, 'usage.json'));
    rmSync(join(scratch, 'codex'));
    const fallback = spawnSync(process.execPath, ['plugins/usage-status/rpc.mjs'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: scratch, MUXR_CCUSAGE_BIN: join(scratch, 'missing') }, timeout: 20_000,
    });
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackOutput = JSON.parse(fallback.stdout);
    assert.ok(fallbackOutput.items.some((item) => item.id === 'ccusage-unavailable'));
    assert.ok(fallbackOutput.items.some((item) => item.id === 'available-claude' && item.metadata[0]?.value === 'Installed'));
    assert.doesNotMatch(fallback.stdout, /OpenAI Codex current limit|Local activity today/);
    assert.ok(!existsSync(piMarker), 'Fallback Usage invoked Pi');
    process.stdout.write('PASS e2e: bounded offline ccusage aggregation + safe live limits\n');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
