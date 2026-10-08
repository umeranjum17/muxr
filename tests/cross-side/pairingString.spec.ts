/**
 * Scanning a QR on the phone and landing on a working herd screen.
 *
 * The producer and the consumer live on opposite sides of the repo: the CLI
 * builds the string with `pairingIntent().pairingLocator()` and prints it as a
 * QR, and the phone has to accept exactly that. Nothing checked that they
 * agreed, so a broken scan regex made the camera silently ignore a real code --
 * the product unusable on first contact -- with the whole suite green.
 *
 * So this drives the real producer into the real consumers rather than pasting
 * fixture strings: change either side and this goes red.
 */
import { Host, keyPair } from '@byokit/link';
import { describe, expect, it } from 'vitest';
import { pairingIntent } from './host';
import { decidePairingInput, hostedPairingAuthority, looksLikeLinkOffer, looksLikePairingLink, parsePairingString } from '@/pairing/domain/pairingString';
import { redirectSystemPath } from '@/app/+native-intent';

/** Every relay address `muxr setup` can end up printing a QR for. */
const relays = [
    'ws://192.168.1.24:8792',
    'ws://100.101.102.103:8792',
    'wss://relay.example.test',
];

describe('a scanned pairing QR reaches pairing', () => {
    it('routes a real native link offer through app schemes and HTTPS to the Pair screen', async () => {
        const host = await Host.open({ keys: keyPair(), name: 'Desk', handle: () => ({}), confirm: () => true });
        try {
            const offer = host.offer({ urls: [`ws://100.124.161.1:57709/link/v1/${host.id}`], role: 'control' }).text;
            for (const url of [offer, ...['muxr', 'muxr-dev', 'muxr-preview'].map((scheme) => `${scheme}://pair#${offer}`), `https://relay.example.test/pair#${offer}`]) {
                expect(looksLikeLinkOffer(url)).toBe(true);
                expect(redirectSystemPath({ path: url, initial: true })).toBe(`/pair?offer=${encodeURIComponent(offer)}`);
            }
            expect(redirectSystemPath({ path: 'muxr-dev://pair#byokit-link:1:bad?', initial: true })).toBe('muxr-dev://pair#byokit-link:1:bad?');
        } finally { host.close(); }
    });

    it('accepts what the CLI prints and carries its authority through to the consent copy', () => {
        for (const relay of relays) {
            const scanned = pairingIntent({ kind: 'native' }).pairingLocator(relay, 'ABCD1234EF');

            // The scanner drops anything this rejects, without a word to the user.
            expect(looksLikePairingLink(scanned)).toBe(true);

            const parsed = parsePairingString(scanned);
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) return;
            expect(parsed.pairing.url).toBe(scanned);
            // A phone gets terminal control; unknown consent copy must never
            // understate it.
            expect(parsed.pairing.authority).toBe('control');
            expect(new URL(parsed.pairing.url).searchParams.get('pair')).toBe('ABCD1234EF');
        }

        // Self-host pair codes resolve into a muxr:// link carrying the
        // signed payload, and the phone meets that shape again as a scanned
        // QR or a deep link. The camera gate drops anything it rejects,
        // without a word to the user.
        const selfhost = 'muxr://pair?payload=eyJ2IjoiMiIsImF1dGhvcml0eSI6ImNvbnRyb2wiLCJuYW1lIjoib2ZmaWNlIn0';
        expect(looksLikePairingLink(selfhost)).toBe(true);
        const selfhostParsed = parsePairingString(selfhost);
        expect(selfhostParsed.ok).toBe(true);
        if (!selfhostParsed.ok) return;
        expect(selfhostParsed.pairing.authority).toBe('control');
        expect(selfhostParsed.pairing.displayName).toBe('office');

        // Browser links are opened, not scanned, so the camera gate does not
        // see them -- but the authority the CLI asked for has to survive, or
        // the browser consent prompt lies about what it is granting.
        for (const authority of ['control', 'observe'] as const) {
            const link = pairingIntent({ kind: 'browser', authority })
                .pairingLocator('wss://relay.example.test', 'ABCD1234EF');
            const parsed = parsePairingString(link);
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) return;
            expect(parsed.pairing.authority).toBe(authority);
            expect(hostedPairingAuthority(link)).toBe(authority);
        }
    });

    it('ignores barcodes that are not pairing links, and refuses look-alikes that are', () => {        // The camera reports everything in view; none of this may open a
        // confirmation prompt.
        for (const noise of [
            'WIFI:S:cafe;T:WPA;P:hunter2;;',
            'https://muxr.dev',
            'https://example.test/pairing',
            'ws://192.168.1.24:8792',
            '',
        ]) {
            expect(looksLikePairingLink(noise)).toBe(false);
        }

        // These do reach pairing, and pairing is what has to refuse them.
        const spoofed = 'ws://good.example.test@evil.example.test:8792/?pair=ABCD1234EF';
        expect(looksLikePairingLink(spoofed)).toBe(true);
        expect(parsePairingString(spoofed)).toMatchObject({ ok: false });

        const trailing = 'ws://192.168.1.24:8792/?pair=ABCD1234EF&redirect=evil';
        expect(looksLikePairingLink(trailing)).toBe(true);
        expect(parsePairingString(trailing)).toMatchObject({ ok: false });
    });

    it('recognises a real compact offer the way the small-terminal QR prints it', async () => {
        const host = await Host.open({ keys: keyPair(), name: 'Desk', handle: () => ({}), confirm: () => true });
        try {
            const compact = host.compactOffer({ urls: [`ws://100.124.161.1:57709/link/v1/${host.id}`], role: 'control' }).text;
            // The scanner gate, the paste taxonomy, and the consent name all
            // read the compact shape; anything else carrying the link tag is
            // a cut-off code, never a silent ignore.
            expect(looksLikePairingLink(compact)).toBe(true);
            expect(looksLikeLinkOffer(compact)).toBe(true);
            expect(decidePairingInput(compact)).toMatchObject({ ok: true, offer: compact });
            expect(decidePairingInput(`${compact.slice(0, 20)} `)).toMatchObject({ ok: false });
            // The same offer arriving as a deep link unwraps to the same text.
            for (const url of [`muxr-dev://pair#${compact}`, `https://relay.example.test/pair#${compact}`]) {
                expect(looksLikeLinkOffer(url)).toBe(true);
                expect(redirectSystemPath({ path: url, initial: true })).toBe(`/pair?offer=${encodeURIComponent(compact)}`);
            }
            const { linkOfferName } = await import('@/pairing/infrastructure/linkPairClient');
            expect(linkOfferName(compact)).toBe('Desk');
        } finally { host.close(); }
    });
});
