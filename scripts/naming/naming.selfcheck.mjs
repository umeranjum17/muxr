#!/usr/bin/env node
/**
 * Boundary self-check for agent naming and the preview loopback. `muxr name`
 * runs against a tiny Herdr command fixture so target binding, verbatim names
 * and truthful partial results cannot regress silently; the preview route is
 * driven over the real HTTP server, including auth and restart.
 */

import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  "pane get w2:p5") printf '%s\\n' '{"result":{"pane":{"pane_id":"w2:p5","workspace_id":"w2"}}}' ;;
  *) printf '%s\\n' '{"result":{}}' ;;
esac
`);
await chmod(fakeHerdr, 0o755);

let server;
async function startServer() {
    server = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
        env: {
            ...process.env,
            MUXR_HOME: root,
            MUXR_NAMING_PORT: '0',
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

const name = (args, paneId = 'w2:p5') => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'name', ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HERDR_PANE_ID: paneId, HERDR_BIN_PATH: fakeHerdr, HERDR_BIN: fakeHerdr },
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

const previewHeaders = (paneId = 'w2:p5') => ({
    authorization: 'Bearer check-token',
    origin: 'muxr://agent',
    'x-muxr-pane-id': paneId,
});

const previewGet = async (port, paneId, extraHeaders) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/preview-status?pane_id=${encodeURIComponent(paneId)}`, {
        headers: extraHeaders ?? previewHeaders(paneId),
    });
    return { status: res.status, body: await res.json() };
};

try {
    let port = await startServer();
    const named = name(['--workspace', 'auth rework / -carefully', '--pane', 'Fix login validation --carefully', '--provider', 'provider with spaces', '--model', 'model/v1:fast']);
    check('verbatim naming flow returns complete ok', named.status === 0 && named.output.includes('"ok":true') && named.output.includes('"status":"ok"'), named.output);
    const namedCalls = await calls();
    check('pane target is resolved before mutation', namedCalls[0] === 'pane get w2:p5', namedCalls.join(' | '));
    check('pane label preserves punctuation/spaces', namedCalls.includes('pane rename w2:p5 Fix login validation --carefully'));
    check('workspace uses Herdr membership, not pane-id splitting', namedCalls.includes('workspace rename w2 auth rework / -carefully'));
    check('provider/model use canonical Herdr metadata tokens', namedCalls.includes('pane report-metadata w2:p5 --source muxr.naming --token provider=provider with spaces --token model=model/v1:fast'));

    const callCount = namedCalls.length;
    const flagLike = name(['--pane', '-leading-dash']);
    check('flag-like rename is rejected rather than reinterpreted', flagLike.status === 1 && flagLike.output.includes('must not start'), flagLike.output);
    const controlChars = name(['--workspace', 'line\nbreak']);
    check('control characters are rejected', controlChars.status === 1, controlChars.output);
    const badTarget = name(['--pane', 'x'], 'not a target');
    check('malformed pane target is rejected before Herdr', badTarget.status === 1, badTarget.output);
    const outsidePane = name(['--pane', 'x'], '');
    check('outside a pane naming refuses to guess an id', outsidePane.status === 1 && outsidePane.output.includes('HERDR_PANE_ID'), outsidePane.output);
    const nothing = name([]);
    check('an empty request is refused', nothing.status === 1, nothing.output);
    check('rejected requests have no Herdr side effect', (await calls()).length === callCount);

    await writeFile(failFile, 'pane-get\n');
    const preflightDown = name(['--pane', 'Preflight down']);
    check('preflight Herdr failure surfaces its concrete cause', preflightDown.status === 1 && preflightDown.output.includes('server_not_running') && preflightDown.output.includes('ECONNREFUSED'), preflightDown.output);
    check('preflight failure mutates nothing', !(await calls()).some((line) => line.includes('Preflight down')));
    await rm(failFile, { force: true });

    await writeFile(failFile, 'workspace\n');
    const partial = name(['--pane', 'CLI partial', '--workspace', 'CLI partial workspace', '--provider', 'pi']);
    check('partial Herdr failure is not overall success', partial.status === 1 && partial.output.includes('partial') && partial.output.includes('workspace: workspace_unavailable'), partial.output);
    check('partial failure still applied the other operations', (await calls()).includes('pane rename w2:p5 CLI partial'));
    await rm(failFile, { force: true });

    await writeFile(slowFile, 'slow\n');
    const slow = name(['--pane', 'CLI slow', '--workspace', 'CLI slow workspace', '--provider', 'pi', '--model', 'model-slow']);
    check('naming waits out a slow Herdr sequence and reports success', slow.status === 0 && slow.output.includes('"ok":true'), slow.output);
    await rm(slowFile, { force: true });

    // Preview status reads the host's human lease, never Herdr.
    const leaseFile = join(root, 'preview', 'lease.json');
    await mkdir(join(root, 'preview'), { recursive: true });
    const writeLease = (panes) => writeFile(leaseFile, `${JSON.stringify({ version: 1, panes })}\n`);
    const absent = await previewGet(port, 'w2:p5');
    check('missing lease file reads as none', absent.status === 200 && absent.body.controller === 'none', JSON.stringify(absent.body));
    await writeLease({ 'w2:p5': { controller: 'human', expiresAt: Date.now() + 30_000 } });
    const held = await previewGet(port, 'w2:p5');
    check('live human lease reads as human', held.status === 200 && held.body.controller === 'human', JSON.stringify(held.body));
    const otherPane = await previewGet(port, 'w2:p6', previewHeaders('w2:p6'));
    check('a lease for another pane reads as none here', otherPane.status === 200 && otherPane.body.controller === 'none', JSON.stringify(otherPane.body));
    await writeLease({ 'w2:p5': { controller: 'human', expiresAt: Date.now() - 1_000 } });
    const expired = await previewGet(port, 'w2:p5');
    check('expired lease reads as none without the host', expired.status === 200 && expired.body.controller === 'none', JSON.stringify(expired.body));
    await writeFile(leaseFile, 'not json\n');
    const corrupt = await previewGet(port, 'w2:p5');
    check('corrupt lease reads as none, never a failure', corrupt.status === 200 && corrupt.body.controller === 'none', JSON.stringify(corrupt.body));
    const previewUnauthorized = await previewGet(port, 'w2:p5', { origin: 'muxr://agent' });
    check('preview status without the local capability is unauthorized', previewUnauthorized.status === 401, JSON.stringify(previewUnauthorized));
    const previewForeign = await previewGet(port, 'w2:p6', previewHeaders('w2:p5'));
    check('preview status for another pane is forbidden', previewForeign.status === 403, JSON.stringify(previewForeign));
    const previewMalformed = await previewGet(port, 'not-a-herdr-target');
    check('malformed preview pane is rejected', previewMalformed.status === 400, JSON.stringify(previewMalformed));

    await writeLease({ 'w2:p5': { controller: 'human', expiresAt: Date.now() + 30_000 } });
    const statusEnv = { ...process.env, HERDR_PANE_ID: 'w2:p5', MUXR_NAMING_PORT: String(port), MUXR_NAMING_AUTH_FILE: authFile };
    const cli = (args, env = statusEnv) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'preview', ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env,
    });
    const human = cli(['status']);
    check('CLI prints the word an agent pauses on', human.status === 0 && human.stdout.trim() === 'human', `${human.stdout}${human.stderr}`);
    const humanJson = cli(['status', '--json']);
    check('CLI --json prints the lease record', humanJson.status === 0 && humanJson.stdout.includes('"controller":"human"'), humanJson.stdout);
    await writeLease({});
    const none = cli(['status']);
    check('CLI prints none when the pane is free', none.status === 0 && none.stdout.trim() === 'none', `${none.stdout}${none.stderr}`);
    const noPane = cli(['status'], { ...statusEnv, HERDR_PANE_ID: '' });
    check('CLI outside a pane refuses to guess an id', noPane.status === 1 && noPane.stderr.includes('HERDR_PANE_ID'), `${noPane.stdout}${noPane.stderr}`);
    const badFlag = cli(['status', '--verbose']);
    check('CLI rejects unknown flags with usage', badFlag.status === 1 && badFlag.stderr.includes('usage'), `${badFlag.stdout}${badFlag.stderr}`);

    await stopServer();
    port = await startServer();
    const restarted = await previewGet(port, 'w2:p5');
    check('restart preserves muxr authorization', restarted.status === 200 && restarted.body.ok === true, JSON.stringify(restarted.body));
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
