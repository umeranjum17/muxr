// Run the real relay + host + paired DeviceLink flow for the entire contract
// vocabulary and an RPC round-trip; the old unauthenticated socket probe is gone.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run',
    'scripts/diagnostics/application/linkPairing.integration.test.ts',
    '-t', 'full event vocabulary'], { stdio: 'inherit' });
process.exit(run.status ?? 1);
