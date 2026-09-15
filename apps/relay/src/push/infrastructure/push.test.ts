import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from './push.js';

describe('isAllowedPushEndpoint ipv4-mapped ipv6', () => {
    it('rejects hex and expanded spellings of a private mapped address', () => {
        expect(isAllowedPushEndpoint('https://[::ffff:c0a8:101]/push')).toBe(false);
        expect(isAllowedPushEndpoint('https://[0:0:0:0:0:ffff:c0a8:101]/push')).toBe(false);
    });

    it('still rejects the dotted spelling and allows a public endpoint', () => {
        expect(isAllowedPushEndpoint('https://[::ffff:192.168.1.1]/push')).toBe(false);
        expect(isAllowedPushEndpoint('https://push.example.com/push')).toBe(true);
    });
});
