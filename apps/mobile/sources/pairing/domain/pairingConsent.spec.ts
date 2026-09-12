import { describe, expect, it } from 'vitest';
import { pairingIntent } from '../../../../../scripts/setup/domain/pairing';
import { hostedPairingAuthority, hostedPairingDisplayName, hostedPairingLifetime, parseBrowserPairingQr, parsePairingString } from './pairingString';

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
});
