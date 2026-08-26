import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PEER_MUTATION_MAX_TTL_MS, PEER_MUTATION_TTL_MS } from '@muxr/contract';
import { PeerReceiptExecutor } from './receiptExecutor.js';
import { PeerStore } from './store.js';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PeerReceiptExecutor mutation window', () => {
    it('accepts a producer one second ahead while rejecting an exact-limit window', async () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-peer-receipt-'));
        roots.push(root);
        const hostNow = 1_000;
        const producerNow = hostNow + 1_000;
        const executor = new PeerReceiptExecutor(new PeerStore(root), () => hostNow);

        await expect(executor.execute(
            'peer-device',
            'peer.prepare',
            { operationId: 'skew-safe', notValidAfter: producerNow + PEER_MUTATION_TTL_MS },
            { target: 'machine' },
            async () => 'ok',
        )).resolves.toBe('ok');

        await expect(executor.execute(
            'peer-device',
            'peer.prepare',
            { operationId: 'exact-limit', notValidAfter: producerNow + PEER_MUTATION_MAX_TTL_MS },
            { target: 'machine' },
            async () => 'unreachable',
        )).rejects.toMatchObject({ code: 'peer-mutation-invalid' });
    });
});
