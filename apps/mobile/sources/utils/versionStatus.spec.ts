import { describe, expect, it } from 'vitest';
import { knownHostVersion, versionsMismatch } from '@/utils/versionStatus';

describe('versionStatus', () => {
    it('flags a mismatch only when both versions are known and differ', () => {
        expect(versionsMismatch('0.1.9', '0.1.6')).toBe(true);
        expect(versionsMismatch('0.1.9', '0.1.9')).toBe(false);
        // Unwired ('0.0.0') and silent ('muxr' placeholder / absent) hosts are
        // "unknown", never a mismatch.
        expect(knownHostVersion('0.0.0')).toBeUndefined();
        expect(knownHostVersion('muxr')).toBeUndefined();
        expect(knownHostVersion(undefined)).toBeUndefined();
        expect(versionsMismatch('0.1.9', '0.0.0')).toBe(false);
        expect(versionsMismatch('0.1.9', undefined)).toBe(false);
        expect(knownHostVersion('0.1.6')).toBe('0.1.6');
    });
});
