// Lab stand-in for the setup wizard's apply step only: `finish` saves the host
// state the real apply writes and returns 0; `cancel` returns 0 with nothing saved.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export * from 'lab:real-wizard';
export async function applyMachineSetup() {
    if (process.env.MUXR_LAB_SETUP === 'finish') {
        mkdirSync(process.env.MUXR_HOME, { recursive: true });
        writeFileSync(join(process.env.MUXR_HOME, 'selfhost.json'), JSON.stringify({ version: 1, relayLocation: 'local', connectionMode: 'lan', relayRole: 'host' }));
        process.stdout.write('  Open muxr on your phone and tap Start.\n');
    } else process.stdout.write('  Cancelled. Nothing changed.\n');
    return 0;
}
