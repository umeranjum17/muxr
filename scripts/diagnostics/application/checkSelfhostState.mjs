/**
 * A truncated selfhost.json (crashed write, full disk) used to kill bare
 * `muxr` and `muxr doctor` with a raw stack trace — the one command whose job
 * is diagnosing a broken install. Corrupt must also never look like "not
 * configured": reconfiguring would mint a new machine identity and destroy
 * every pairing. This flow also proves an unresponsive local relay port fails
 * promptly instead of leaving setup waiting forever.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-selfhost-state-'));
process.env.MUXR_HOME = scratch;
process.env.MUXR_NO_SERVICE_COMMANDS = '1';
const { ensureSelfhostRelay, inspectSetup, selfhostConfigured, selfhostStateUnreadable, startSelfHost } = await import('../../setup/index.mjs');

assert.equal(selfhostConfigured(), false);
assert.equal(selfhostStateUnreadable(), false);

writeFileSync(join(scratch, 'selfhost.json'), '{"version":1,"relayPort":');
assert.equal(selfhostConfigured(), false);
assert.equal(selfhostStateUnreadable(), true);
assert.equal(await startSelfHost(['--dry-run']), 1, 'self-host setup must refuse to reconfigure over corrupt state');
assert.equal(await inspectSetup(), 1, 'doctor must fail over corrupt selfhost state');

writeFileSync(join(scratch, 'selfhost.json'), '{"version":1,"relayPort":8792}\n');
assert.equal(selfhostConfigured(), true);
assert.equal(selfhostStateUnreadable(), false);

const sockets = new Set();
const blackhole = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
const started = Date.now();
try {
    await assert.rejects(ensureSelfhostRelay(blackhole.address().port), /accepts connections but did not answer/);
    assert.ok(Date.now() - started < 5_000, 'an unresponsive local port stalled setup');
    assert.equal(existsSync(join(scratch, 'relay', 'relay.pid')), false, 'stalled setup left a relay process behind');
} finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => blackhole.close(resolve));
}

process.stdout.write('selfhost state and stalled relay checks passed\n');
