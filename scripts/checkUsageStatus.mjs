import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-usage-'));
const piMarker = join(scratch, 'pi-ran');
try {
    writeFileSync(join(scratch, 'pi'), `#!/bin/sh\ntouch "${piMarker}"\nexit 99\n`, { mode: 0o755 });
    writeFileSync(join(scratch, 'codex'), `#!/usr/bin/env node\nlet b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;for(;;){const i=b.indexOf('\\n');if(i<0)break;const line=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,resetsAt:Math.floor(Date.now()/1000)+3600}}}}}));}});\n`, { mode: 0o755 });
    for (const command of ['claude', 'kimi', 'grok']) writeFileSync(join(scratch, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, ['plugins/usage-status/rpc.mjs'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` }, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const text = JSON.parse(result.stdout);
    assert.match(text, /OpenAI Codex[\s\S]*75% left/);
    assert.match(text, /Anthropic Claude[\s\S]*open \/usage in that CLI/);
    assert.match(text, /Kimi Code[\s\S]*open \/usage in that CLI/);
    assert.ok(!existsSync(piMarker), 'Usage plugin invoked Pi and could enter a paid model path');

    rmSync(join(scratch, 'codex'));
    const fallback = spawnSync(process.execPath, ['plugins/usage-status/rpc.mjs'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: scratch }, timeout: 15_000,
    });
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackText = JSON.parse(fallback.stdout);
    assert.doesNotMatch(fallbackText, /OpenAI Codex/);
    assert.match(fallbackText, /Anthropic Claude[\s\S]*open \/usage in that CLI/);
    assert.ok(!existsSync(piMarker), 'Fallback Usage invoked Pi');
    process.stdout.write('PASS e2e: safe multi-provider usage aggregation\n');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
