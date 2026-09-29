import { describe, expect, it } from 'vitest';
import { startAgent } from './startAgent';

describe('startAgent host error propagation', () => {
    it('returns the host failure message instead of a generic one', async () => {
        const result = await startAgent({ directory: '/tmp/proj' }, {
            startOnHost: async () => { throw new Error('host out of disk space'); },
            waitUntilListed: async () => undefined,
            missingDirectory: () => false,
        });
        expect(result).toEqual({ ok: false, reason: 'rejected', message: 'host out of disk space' });
    });
});
