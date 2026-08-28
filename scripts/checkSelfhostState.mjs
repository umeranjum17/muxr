/**
 * A truncated selfhost.json (crashed write, full disk) used to kill bare
 * `muxr` and `muxr doctor` with a raw stack trace — the one command whose job
 * is diagnosing a broken install. Corrupt must also never look like "not
 * configured": reconfiguring would mint a new machine identity and destroy
 * every pairing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-selfhost-state-'));
process.env.MUXR_HOME = scratch;
process.env.MUXR_NO_SERVICE_COMMANDS = '1';
const { runDoctor } = await import('./local-setup.mjs');
const { selfhostConfigured, selfhostStateUnreadable, runSelfHost } = await import('./selfhostRuntime.mjs');

assert.equal(selfhostConfigured(), false);
assert.equal(selfhostStateUnreadable(), false);

writeFileSync(join(scratch, 'selfhost.json'), '{"version":1,"relayPort":');
assert.equal(selfhostConfigured(), false);
assert.equal(selfhostStateUnreadable(), true);
assert.equal(await runSelfHost(['--dry-run']), 1, 'self-host setup must refuse to reconfigure over corrupt state');
assert.equal(await runDoctor(), 1, 'doctor must fail over corrupt selfhost state');

writeFileSync(join(scratch, 'selfhost.json'), '{"version":1,"relayPort":8792}\n');
assert.equal(selfhostConfigured(), true);
assert.equal(selfhostStateUnreadable(), false);
process.stdout.write('selfhost state parsing passed\n');
