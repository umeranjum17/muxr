import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MachineCryptoState } from '../domain/crypto.js';

export function writeSelfhostCrypto(path: string, crypto: MachineCryptoState): void {
    const state = JSON.parse(readFileSync(path, 'utf8')) as { machine: { crypto: MachineCryptoState } };
    const current = state.machine.crypto;
    if (current.signingPublicKey !== crypto.signingPublicKey || current.boxPublicKey !== crypto.boxPublicKey) {
        throw new Error('machine identity changed; refusing to restore retired keys');
    }
    state.machine.crypto = crypto;
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
}
