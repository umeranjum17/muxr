import { describe, expect, it } from 'vitest';
import { pairingIntent } from '../../../../../scripts/setup/domain/pairing';
import { expandCompactPairingPayload, hostedPairingAuthority, hostedPairingDisplayName, hostedPairingLifetime, parseBrowserPairingQr, parsePairingString, reviewedConsentMismatch } from './pairingString';
import { acceptVerifiedGrant, reviewedGrantCeiling } from './hostedGrant';

/** The sealed payload exactly as pairDevice.mjs builds it (before code-sealing). */
function sealedPayload(fields: Record<string, string>): URLSearchParams {
    const compact = Buffer.from(JSON.stringify({ v: '2', generation: '1', id: 'pair-id', claim: 'c', pair: 'p', machine: 'machine-1', machinePk: 'k', r: 'wss://relay.example.test', authority: 'control', ...fields })).toString('base64url');
    const fragment = new URLSearchParams({ payload: compact });
    expandCompactPairingPayload(fragment);
    return fragment;
}

// The certified failure: the QR named "this machine" although the host is
// called Android-Cert, and native consent carried no expiry. The locator the
// CLI prints is the one the app parses, so drive that exact string end to end
// and read what consent would show before any claim or network access.
describe('pairing consent metadata from the printed locator', () => {
    const code = 'ABCDE-FGHJK';

    it('native QR names the computer, full control, until revoked', () => {
        const printed = pairingIntent({ kind: 'native' }).pairingLocator('ws://127.0.0.1:8792', code, 'Android-Cert');
        expect(printed).toBe(`ws://127.0.0.1:8792/?pair=${code}&name=Android-Cert`);
        const parsed = parsePairingString(printed);
        expect(parsed).toMatchObject({ ok: true, pairing: { authority: 'control', displayName: 'Android-Cert' } });
        expect(hostedPairingDisplayName(printed)).toBe('Android-Cert');
        expect(hostedPairingAuthority(printed)).toBe('control');
        // Names are display-only: the manual string still pairs without one.
        expect(parsePairingString(`ws://127.0.0.1:8792/?pair=${code}`)).toMatchObject({ ok: true, pairing: { displayName: 'this machine' } });
        // Browser scanners refuse the native locator as before.
        expect(parseBrowserPairingQr(printed)).toMatchObject({ ok: false });
    });

    it('browser QR/link names the computer, the role and the lifetime', () => {
        const control = pairingIntent({ kind: 'browser', authority: 'control' }).pairingLocator('wss://relay.example.test', code, "Umer's MacBook Pro");
        expect(control).toBe(`https://relay.example.test/pair?pair=${code}&role=control&name=Umer%27s+MacBook+Pro`);
        const scanned = parseBrowserPairingQr(control);
        expect(scanned).toMatchObject({ ok: true, qr: { authority: 'control', personal: false, displayName: "Umer's MacBook Pro", origin: 'https://relay.example.test' } });
        expect(parsePairingString(control)).toMatchObject({ ok: true, pairing: { authority: 'control', displayName: "Umer's MacBook Pro" } });
        expect(hostedPairingLifetime(control)).toBe('eight hours');

        const personalView = pairingIntent({ kind: 'browser', authority: 'observe', personal: true }).pairingLocator('wss://relay.example.test', code, 'Studio');
        expect(parseBrowserPairingQr(personalView)).toMatchObject({ ok: true, qr: { authority: 'observe', personal: true, displayName: 'Studio' } });
        expect(hostedPairingLifetime(personalView)).toBe('30 days');
    });

    it('never echoes unsafe names and keeps the strict link shape', () => {
        // The CLI drops a name it cannot print safely instead of emitting it.
        const unsafe = pairingIntent({ kind: 'browser', authority: 'control' }).pairingLocator('wss://relay.example.test', code, 'evil‮drocer');
        expect(unsafe).not.toContain('name=');
        expect(parsePairingString(unsafe)).toMatchObject({ ok: true, pairing: { displayName: 'this machine' } });
        // A hand-edited link with a name outside the bounded charset is a tampered link.
        for (const tampered of [
            `https://relay.example.test/pair?pair=${code}&role=control&name=${encodeURIComponent('<script>')}`,
            `https://relay.example.test/pair?pair=${code}&role=control&name=${'x'.repeat(41)}`,
            `https://relay.example.test/pair?pair=${code}&role=control&name=a&name=b`,
            `ws://127.0.0.1:8792/?pair=${code}&name=${encodeURIComponent('login@host')}`,
        ]) {
            expect(parseBrowserPairingQr(tampered)).toMatchObject({ ok: false });
            expect(parsePairingString(tampered)).toMatchObject({ ok: false });
        }
        // The display name is not authority: a link claiming a name still reads its role from the link, and an unknown role stays control.
        expect(hostedPairingAuthority(`https://relay.example.test/pair?pair=${code}&role=observe&name=Boss`)).toBe('observe');
    });

    it('binds the reviewed name and lifetime to the sealed code before any claim, and caps the grant', () => {
        const sealed = sealedPayload({ name: 'Android-Cert' });
        // The ordinary QR: reviewed name equals the sealed name.
        expect(reviewedConsentMismatch({ name: 'Android-Cert', lifetime: 'eight hours' }, sealed)).toBeUndefined();
        // Only the public name changed: refused with a static message.
        expect(reviewedConsentMismatch({ name: 'Trusted-Laptop', lifetime: 'eight hours' }, sealed)).toMatch(/names a different computer/);
        // An unnamed link binds nothing; the sealed name still shows afterwards.
        expect(reviewedConsentMismatch({ name: 'this machine', lifetime: 'eight hours' }, sealed)).toBeUndefined();
        // personal=1 removed from a personal invitation (or added to a standard one): refused.
        const personal = sealedPayload({ name: 'Studio', personal: '1' });
        expect(reviewedConsentMismatch({ name: 'Studio', lifetime: 'eight hours' }, personal)).toMatch(/different access lifetime/);
        expect(reviewedConsentMismatch({ name: 'Studio', lifetime: '30 days' }, personal)).toBeUndefined();
        expect(reviewedConsentMismatch({ name: 'Android-Cert', lifetime: '30 days' }, sealed)).toMatch(/different access lifetime/);

        // The verified grant may not outlive what was reviewed, on first claim or resume.
        const claimedAt = Date.parse('2026-09-12T12:00:00Z');
        const base = { verifiedMachineId: 'machine-1', pendingMachineId: 'machine-1', verifiedAuthority: 'control' as const, expectedAuthority: 'control' as const, platform: 'web' };
        const eightHours = reviewedGrantCeiling('eight hours', claimedAt);
        expect(acceptVerifiedGrant({ ...base, verifiedExpiresAt: claimedAt + 8 * 60 * 60_000, expiresNoLaterThan: eightHours })).toMatchObject({ ok: true });
        expect(acceptVerifiedGrant({ ...base, verifiedExpiresAt: claimedAt + 30 * 24 * 60 * 60_000, expiresNoLaterThan: eightHours })).toEqual({ ok: false, error: 'lifetime-substitution' });
        expect(acceptVerifiedGrant({ ...base, verifiedExpiresAt: claimedAt + 30 * 24 * 60 * 60_000, expiresNoLaterThan: reviewedGrantCeiling('30 days', claimedAt) })).toMatchObject({ ok: true });
        expect(acceptVerifiedGrant({ ...base, expiresNoLaterThan: eightHours })).toEqual({ ok: false, error: 'lifetime-substitution' });
        // Native pairing reviewed "until revoked": no ceiling, durable grant accepted.
        expect(acceptVerifiedGrant({ ...base, platform: 'android', verifiedExpiresAt: Date.UTC(9999, 11, 31) })).toMatchObject({ ok: true });
    });

    it('refuses an outer name on a compact link, binds every accepted form after expansion, and requires a browser ceiling', () => {
        const compact = Buffer.from(JSON.stringify({ v: '2', generation: '1', id: 'pair-id', claim: 'c'.repeat(24), pair: 'p'.repeat(24), machine: 'machine-1'.padEnd(24, '1'), machinePk: 'k'.repeat(24), r: 'wss://relay.example.test', authority: 'control', name: 'Android-Cert' })).toString('base64url');
        // The untouched compact link shows its sealed name.
        expect(parsePairingString(`muxr://pair?payload=${compact}`)).toMatchObject({ ok: true, pairing: { displayName: 'Android-Cert' } });
        // An outer name beside the payload is not a valid link at all.
        expect(parsePairingString(`muxr://pair?payload=${compact}&name=Trusted-Laptop`)).toMatchObject({ ok: false });
        // And even if it were reviewed, the sealed comparison refuses it before any claim.
        const expanded = sealedPayload({ name: 'Android-Cert' });
        expect(reviewedConsentMismatch({ name: 'Trusted-Laptop', lifetime: 'eight hours' }, expanded)).toMatch(/names a different computer/);
        expect(reviewedConsentMismatch({ name: hostedPairingDisplayName(`muxr://pair?payload=${compact}`), lifetime: 'eight hours' }, expanded)).toBeUndefined();

        // A browser claim without a reviewed ceiling is refused; native is not.
        const base = { verifiedMachineId: 'machine-1', pendingMachineId: 'machine-1', verifiedAuthority: 'control' as const, expectedAuthority: 'control' as const, verifiedExpiresAt: Date.now() + 60_000 };
        expect(acceptVerifiedGrant({ ...base, platform: 'web' })).toEqual({ ok: false, error: 'lifetime-substitution' });
        expect(acceptVerifiedGrant({ ...base, platform: 'web', expiresNoLaterThan: Number.NaN })).toEqual({ ok: false, error: 'lifetime-substitution' });
        expect(acceptVerifiedGrant({ ...base, platform: 'web', expiresNoLaterThan: reviewedGrantCeiling('eight hours', Date.now()) })).toMatchObject({ ok: true });
        expect(acceptVerifiedGrant({ ...base, platform: 'android', verifiedExpiresAt: Date.UTC(9999, 11, 31) })).toMatchObject({ ok: true });
    });
});
