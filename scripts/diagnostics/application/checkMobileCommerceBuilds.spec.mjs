/**
 * The commerce-build guard bans the removed singular hosted-account screen
 * (settings/account) but must not trip on the plans route settings/accounts.
 * Drives the single pattern the check itself uses, so the two cannot drift.
 */
import { describe, expect, it } from 'vitest';
import { hostedAccountUxPattern } from './hostedAccountUxPattern.mjs';

describe('hosted-account UX guard', () => {
    it('still bans the removed singular settings/account screen', () => {
        expect(hostedAccountUxPattern.test("router.push('/settings/account')")).toBe(true);
    });

    it('passes the plans settings/accounts route', () => {
        expect(hostedAccountUxPattern.test("router.push('/settings/accounts')")).toBe(false);
        expect(hostedAccountUxPattern.test('name="settings/accounts"')).toBe(false);
    });
});
