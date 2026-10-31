import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSource } from '../../agent/index.js';
import { TransferStore } from '../infrastructure/transferStore.js';
import { importMove } from './importMove.js';

/** The destination half of a move over the real transfer store: a bundle that arrives damaged or short is refused before any account or agent is touched. */
describe('move: a bundle that arrives damaged is refused and cleaned up', () => {
    it('stages in chunks, answers a repeated chunk with what it holds, and imports nothing on a digest mismatch', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-move-'));
        try {
            const store = new TransferStore(home);
            const transferId = 'a'.repeat(24);
            const bundle = Buffer.from('BYKCONV1'.repeat(100));
            const chunk = (from: number, to: number) => bundle.subarray(from, to).toString('base64');

            expect(store.stage(transferId, 0, chunk(0, 300))).toBe(300);
            expect(store.stage(transferId, 0, chunk(0, 300))).toBe(300);
            expect(() => store.stage(transferId, 500, chunk(500, 800))).toThrow(/went missing/);
            expect(store.stage(transferId, 300, chunk(300, 800))).toBe(800);
            expect(store.staged(transferId)).toMatchObject({ bytes: 800, digest: createHash('sha256').update(bundle).digest('hex') });

            // No source, account or agent may be reached: a refusal here happens before any of them.
            const untouched = new Proxy({}, { get: () => { throw new Error('touched the destination agent'); } }) as unknown as SessionSource;
            const deps = { source: untouched, store, env: { MUXR_HOME: home } as NodeJS.ProcessEnv, rememberPane: async () => { throw new Error('remembered a pane'); } };
            const claim = { transferId, kind: 'claude', conversation: '11111111-2222-4333-8444-555555555555', cwd: '~' };
            await expect(importMove(deps, { ...claim, bytes: 800, digest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'move-corrupt' });
            expect(readdirSync(join(home, 'moves'))).toEqual([]);
            await expect(importMove(deps, { ...claim, kind: 'pi', bytes: 800, digest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'move-unsupported' });
            expect(existsSync(join(home, 'moves', `dst-${transferId}.bundle`))).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
