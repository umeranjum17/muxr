import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    PEER_MUTATION_CLOCK_SKEW_MS,
    PEER_MUTATION_MAX_TTL_MS,
    PEER_MUTATION_TTL_MS,
} from '@muxr/contract';
import { PeerReceiptExecutor } from './receiptExecutor.js';
import { PeerStore } from '../infrastructure/store.js';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PeerReceiptExecutor mutation window', () => {
    it('accepts skew-safe and legacy exact-limit producers while rejecting beyond the allowance', async () => {
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
            async () => 'safe',
        )).resolves.toBe('safe');

        await expect(executor.execute(
            'peer-device',
            'peer.prepare',
            { operationId: 'legacy-exact-limit', notValidAfter: producerNow + PEER_MUTATION_MAX_TTL_MS },
            { target: 'machine' },
            async () => 'legacy',
        )).resolves.toBe('legacy');

        await expect(executor.execute(
            'peer-device',
            'peer.prepare',
            {
                operationId: 'beyond-skew-allowance',
                notValidAfter: hostNow + PEER_MUTATION_MAX_TTL_MS + PEER_MUTATION_CLOCK_SKEW_MS + 1,
            },
            { target: 'machine' },
            async () => 'unreachable',
        )).rejects.toMatchObject({ code: 'peer-mutation-invalid' });
    });
});
