#!/usr/bin/env node
/**
 * Boundary self-check for the naming server. It drives the real HTTP server
 * against a tiny Herdr command fixture so auth, target binding, response
 * truthfulness, and restart behavior cannot regress silently.
 *
 * An owned lab can point HERDR_BIN at the real binary and set
 * MUXR_NAMING_SESSION, but must keep the helper-owned session outside this
 * deterministic check.
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'muxr-naming-check-'));
const fakeHerdr = join(root, 'herdr');
const callsFile = join(root, 'calls.log');
const failFile = join(root, 'fail-operation');
const slowFile = join(root, 'slow-operation');
const authFile = join(root, 'token');
await writeFile(authFile, 'check-token\n', { mode: 0o600 });
await writeFile(fakeHerdr, `#!/bin/sh
printf '%s\\n' "$*" >> '${callsFile}'
if [ -f '${slowFile}' ]; then sleep 3; fi
if [ -f '${failFile}' ] && grep -Fxq pane-get '${failFile}' && printf '%s' "$*" | grep -q 'pane get'; then
  printf '%s\\n' '{"error":{"code":"server_not_running","message":"connect ECONNREFUSED 127.0.0.1:7333"}}'
  exit 0
fi
if [ -f '${failFile}' ] && grep -Fxq workspace '${failFile}' && printf '%s' "$*" | grep -q 'workspace rename'; then
  printf '%s\\n' '{"error":{"code":"workspace_unavailable","message":"workspace failed"}}'
  exit 0
fi
case "$*" in
  *"pane get w2:p5 --session lab"*) printf '%s\\n' '{"result":{"pane":{"pane_id":"w2:p5","workspace_id":"w2"}}}' ;;
  *) printf '%s\\n' '{"result":{}}' ;;
esac
`);
await chmod(fakeHerdr, 0o755);

let server;
async function startServer() {
    server = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
        env: {
            ...process.env,
            MUXR_NAMING_PORT: '0',
            HERDR_BIN: fakeHerdr,
            MUXR_NAMING_SESSION: 'lab',
            MUXR_NAMING_AUTH_FILE: authFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return await new Promise((resolve, reject) => {
        server.stdout.on('data', (chunk) => {
            const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
            if (match) resolve(Number(match[1]));
        });
        server.stderr.on('data', (chunk) => process.stderr.write(chunk));
        server.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
        setTimeout(() => reject(new Error('server never reported a port')), 5000).unref();
    });
}

async function stopServer() {
    if (server === undefined || server.exitCode !== null) return;
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    server = undefined;
}

let failures = 0;
const check = (name, condition, detail) => {
    if (condition) process.stdout.write(`  ok: ${name}\n`);
    else {
        failures += 1;
        process.stderr.write(`  FAIL: ${name}${detail === undefined ? '' : ` — ${detail}`}\n`);
    }
};

const headers = (paneId = 'w2:p5', origin = 'muxr://agent') => ({
    authorization: 'Bearer check-token',
    'content-type': 'application/json',
    origin,
    'x-herdr-session': 'lab',
    'x-muxr-pane-id': paneId,
});

const post = async (port, body, extraHeaders = headers()) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/naming`, {
        method: 'POST',
        headers: extraHeaders,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
};

const rawPost = (port, body, requestHeaders = headers()) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/naming', headers: requestHeaders }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
});

try {
    let port = await startServer();
    const namedBody = {
        pane_id: 'w2:p5',
        workspace: 'auth rework / -carefully',
        pane: 'Fix login validation --carefully',
        provider: 'provider with spaces',
        model: 'model/v1:fast',
    };
    const named = await post(port, namedBody);
    check('verbatim naming flow returns complete ok', named.status === 200 && named.body.ok === true && named.body.status === 'ok', JSON.stringify(named.body));
    check('all supported Herdr operations succeeded', Object.values(named.body.results ?? {}).every(Boolean), JSON.stringify(named.body));

    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n');
    check('pane target is resolved before mutation', calls.some((line) => line.includes('pane get w2:p5 --session lab')));
    check('pane label preserves punctuation/spaces', calls.some((line) => line.includes('pane rename w2:p5 Fix login validation --carefully --session lab')));
    check('workspace uses Herdr membership, not pane-id splitting', calls.some((line) => line.includes('workspace rename w2 auth rework / -carefully --session lab')));
    check('provider/model use canonical Herdr metadata tokens', calls.some((line) => line.includes('pane report-metadata w2:p5 --source muxr.naming --token provider=provider with spaces --token model=model/v1:fast --session lab')));

    const callCount = calls.length;
    const unauthorizedResult = await post(port, namedBody, { 'content-type': 'application/json', origin: 'muxr://agent' });
    check('missing local capability is unauthorized', unauthorizedResult.status === 401, JSON.stringify(unauthorizedResult));
    check('unauthorized request has no Herdr side effect', (await readFile(callsFile, 'utf8')).trim().split('\n').length === callCount);
    const wrongOrigin = await post(port, namedBody, headers('w2:p5', 'http://127.0.0.1'));
    check('wrong origin is unauthorized', wrongOrigin.status === 401, JSON.stringify(wrongOrigin));
    const wrongPane = await post(port, namedBody, headers('w2:p6'));
    check('cross-pane target binding is forbidden', wrongPane.status === 403, JSON.stringify(wrongPane));

    const malformed = await post(port, 'not json');
    check('malformed JSON is rejected', malformed.status === 400, JSON.stringify(malformed));
    const wrongContentType = await post(port, JSON.stringify(namedBody), { ...headers(), 'content-type': 'text/plain' });
    check('non-JSON content type is rejected', wrongContentType.status === 400, JSON.stringify(wrongContentType));
    const workspaceWithoutPane = await post(port, { workspace: 'orphan' });
    check('workspace cannot bypass pane binding', workspaceWithoutPane.status === 400, JSON.stringify(workspaceWithoutPane));
    const malformedTarget = await post(port, { ...namedBody, pane_id: 'not-a-herdr-target' });
    check('malformed target is rejected before Herdr', malformedTarget.status === 400, JSON.stringify(malformedTarget));
    const flagLikeName = await post(port, { pane_id: 'w2:p5', pane: '-leading-dash' });
    check('flag-like rename is rejected rather than reinterpreted', flagLikeName.status === 400, JSON.stringify(flagLikeName));

    const oversized = await rawPost(port, `{"pane":"${'x'.repeat(64 * 1024)}"}`);
    check('oversized body answers 400 to the client', oversized.status === 400, `client saw ${oversized.status}`);

    await writeFile(failFile, 'pane-get\n');
    const preflightDown = await post(port, { pane_id: 'w2:p5', pane: 'Preflight down' });
    check('preflight Herdr failure surfaces its concrete cause', preflightDown.status === 404 && String(preflightDown.body.error).includes('server_not_running') && String(preflightDown.body.error).includes('ECONNREFUSED'), JSON.stringify(preflightDown.body));
    await rm(failFile, { force: true });

    await writeFile(failFile, 'workspace\n');
    const partial = await post(port, { pane_id: 'w2:p5', workspace: 'partial', pane: 'Pane survives', provider: 'pi', model: 'model-partial' });
    check('partial Herdr failure is not overall success', partial.status === 502 && partial.body.ok === false && partial.body.status === 'partial', JSON.stringify(partial.body));
    check('partial result identifies the failed operation', partial.body.results?.pane === true && partial.body.results?.workspace === false && partial.body.results?.metadata === true, JSON.stringify(partial.body));
    const partialClient = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'name', '--pane', 'CLI partial', '--workspace', 'CLI partial workspace'], {
        encoding: 'utf8',
        env: { ...process.env, HERDR_PANE_ID: 'w2:p5', HERDR_SESSION: 'lab', MUXR_NAMING_PORT: String(port), MUXR_NAMING_AUTH_FILE: authFile },
    });
    const partialClientOutput = `${partialClient.stdout ?? ''}${partialClient.stderr ?? ''}`;
    check('CLI preserves partial status and operation detail', partialClient.status === 1 && partialClientOutput.includes('partial') && partialClientOutput.includes('workspace'), partialClientOutput);
    await rm(failFile, { force: true });

    await writeFile(slowFile, 'slow\n');
    const slowClient = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'name', '--pane', 'CLI slow', '--workspace', 'CLI slow workspace', '--provider', 'pi', '--model', 'model-slow'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HERDR_PANE_ID: 'w2:p5', HERDR_SESSION: 'lab', MUXR_NAMING_PORT: String(port), MUXR_NAMING_AUTH_FILE: authFile },
    });
    const slowClientOutput = `${slowClient.stdout ?? ''}${slowClient.stderr ?? ''}`;
    check('CLI waits out a slow Herdr sequence and reports success', slowClient.status === 0 && slowClientOutput.includes('"ok":true'), slowClientOutput);
    await rm(slowFile, { force: true });

    const duplicate = await post(port, namedBody);
    check('duplicate naming remains idempotent', duplicate.status === 200 && duplicate.body.ok === true, JSON.stringify(duplicate.body));

    await stopServer();
    port = await startServer();
    const restarted = await post(port, { pane_id: 'w2:p5', pane: 'After restart' });
    check('restart preserves muxr authorization and naming', restarted.status === 200 && restarted.body.ok === true, JSON.stringify(restarted.body));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    check('health endpoint stays available', health.status === 200);
    let stateExists = true;
    try { await access(join(root, 'state.json')); } catch { stateExists = false; }
    check('no competing JSON metadata authority is created', !stateExists);
} finally {
    await stopServer();
    await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
    process.stderr.write(`naming self-check: ${failures} failure(s)\n`);
    process.exit(1);
}
process.stdout.write('naming self-check: all assertions passed\n');
