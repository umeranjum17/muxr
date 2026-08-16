import { loadRelayConfig } from './config.js';
import { startRelay } from './relay.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const config = loadRelayConfig();

// One relay per dataDir: the ticket/pairing stores are single-process.
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const lockFile = join(config.dataDir, 'relay.pid');
if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8').trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
        let aliveRelay = false;
        try {
            aliveRelay = readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('apps/relay');
        } catch {
            // dead pid: stale lock
        }
        if (aliveRelay) throw new Error(`another relay already owns ${config.dataDir} (pid ${pid})`);
    }
}
writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
process.on('exit', () => {
    try {
        if (readFileSync(lockFile, 'utf8') === String(process.pid)) writeFileSync(lockFile, 'stale', { mode: 0o600 });
    } catch { /* best effort */ }
});

const relay = await startRelay({ port: config.port, host: config.host, config });
process.stdout.write(`relay listening on ws://${config.host}:${relay.port}\n`);
