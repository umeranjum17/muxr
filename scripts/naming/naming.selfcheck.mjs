#!/usr/bin/env node
/**
 * Self-check for the naming server: one flow, real server, fake herdr.
 *
 * Spawns scripts/naming/server.mjs against a stub `herdr` that records its
 * argv, POSTs a naming request, and asserts the exact verbatim names reached
 * the CLI with the right session scoping and the state file landed. Fails
 * loudly if any contract point breaks.
 *
 *   node scripts/naming/naming.selfcheck.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(join(tmpdir(), 'muxr-naming-check-'));
const fakeHerdr = join(root, 'herdr');
const callsFile = join(root, 'calls.log');
const stateFile = join(root, 'state.json');
await writeFile(fakeHerdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsFile}'\nexit 0\n`);
await chmod(fakeHerdr, 0o755);

const server = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    env: {
        ...process.env,
        MUXR_NAMING_PORT: '0',
        HERDR_BIN: fakeHerdr,
        MUXR_NAMING_SESSION: 'lab',
        MUXR_NAMING_STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => {
        const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
        if (match) resolve(Number(match[1]));
    });
    server.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server never reported a port')), 5000).unref();
});

let failures = 0;
const check = (name, condition, detail) => {
    if (condition) process.stdout.write(`  ok: ${name}\n`);
    else {
        failures += 1;
        process.stderr.write(`  FAIL: ${name}${detail === undefined ? '' : ` — ${detail}`}\n`);
    }
};
const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/naming`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
};

try {
    const named = await post({
        pane_id: 'w2:p5',
        workspace: 'auth rework',
        pane: 'Fix login validation --carefully',
        provider: 'pi',
        model: 'gemini-3-flash',
    });
    check('rename flow returns ok', named.status === 200 && named.body.ok === true, JSON.stringify(named.body));
    check('all three herdr calls succeeded', named.body.results.pane === true
        && named.body.results.workspace === true && named.body.results.metadata === true, JSON.stringify(named.body.results));

    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n');
    check('pane label passed verbatim (flags and spaces intact)',
        calls.some((line) => line.includes(`--session lab pane rename w2:p5 Fix login validation --carefully`)), calls.join(' | '));
    check('workspace id derived from pane id, label verbatim',
        calls.some((line) => line.includes(`--session lab workspace rename w2 auth rework`)), calls.join(' | '));
    check('provider/model recorded as herdr metadata tokens',
        calls.some((line) => line.includes(`--session lab pane report-metadata w2:p5 --source muxr.naming --token provider=pi --token model=gemini-3-flash`)), calls.join(' | '));
    const rejected = await post({ pane_id: 'w2:p5', pane: '-leading-dash' });
    check('flag-like leading dash in a name is rejected, not passed through', rejected.status === 400, JSON.stringify(rejected));

    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    check('state file records provider+model for quota tooling',
        state.panes['w2:p5']?.provider === 'pi' && state.panes['w2:p5']?.model === 'gemini-3-flash'
        && state.panes['w2:p5']?.pane === 'Fix login validation --carefully', JSON.stringify(state));

    const update = await post({ pane_id: 'w2:p5', pane: 'Rename only' });
    check('partial update succeeds', update.status === 200 && update.body.ok === true, JSON.stringify(update.body));
    const stateAfter = JSON.parse(await readFile(stateFile, 'utf8'));
    check('partial update keeps earlier provider metadata',
        stateAfter.panes['w2:p5']?.pane === 'Rename only' && stateAfter.panes['w2:p5']?.provider === 'pi', JSON.stringify(stateAfter));

    const missing = await post({ pane: 'no pane id' });
    check('pane naming without pane_id is rejected', missing.status === 400, JSON.stringify(missing));
    const empty = await post({ pane_id: 'w2:p5' });
    check('nothing-to-name is rejected', empty.status === 400, JSON.stringify(empty));
    const junk = await fetch(`http://127.0.0.1:${port}/api/naming`, { method: 'POST', body: 'not json' });
    check('non-JSON body is rejected', junk.status === 400);

    // Raw request (not fetch): the point is that the oversized CLIENT actually
    // receives the 400 instead of a reset connection.
    const oversized = await new Promise((resolve, reject) => {
        let answered = false;
        const request = http.request(
            { host: '127.0.0.1', port, method: 'POST', path: '/api/naming', headers: { 'content-type': 'application/json' } },
            (res) => {
                answered = true;
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            },
        );
        request.on('error', (error) => { if (!answered) reject(error); });
        request.end(`{"pane":"${'x'.repeat(64 * 1024)}"}`);
    });
    check('oversized body (>64 KiB) answers 400 to the client', oversized === 400, `client saw ${oversized}`);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    check('health endpoint answers', health.status === 200);
} finally {
    server.kill('SIGTERM');
    await delay(200);
    await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
    process.stderr.write(`naming self-check: ${failures} failure(s)\n`);
    process.exit(1);
}
process.stdout.write('naming self-check: all assertions passed\n');
