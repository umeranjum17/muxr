import { Platform } from 'react-native';
import { pairOverLink } from './linkPairing';
import { pairMachine } from './PairMachine';

/**
 * Lab-only bridge that lets an isolated browser lab pair a muxr PWA without a
 * real HTTPS relay. The production pairing UI accepts a browser link only as
 * the full `https://…/pair#byokit-link:…` wrapper, so a plain-http lab origin
 * (the relay the lab serves the export from) cannot pair through the UI, and
 * the browser-lab rule forbids seeding the `muxr-secure` IndexedDB by hand.
 *
 * This exposes one page function, `window.__MUXR_LAB_PAIR__(link)`, that pairs
 * through the app's own production path — `pairOverLink` claims and stores the
 * Hosted Grant through `webSecureStore`, `pairMachine` makes it the active
 * connection — so the lab leaves exactly the state a real UI pairing would.
 * A bare `byokit-link:1:…` token is wrapped in an HTTPS `/pair` link because
 * the kit reads the offer from the fragment regardless of the host.
 *
 * The whole registration sits behind a build-time flag that is `undefined` in
 * every production export, so the minifier drops the block (and this string)
 * from the shipped bundle. See `features/lab-browser-pairing.md`.
 */
function installLabBrowserPairing(): void {
    const link = (raw: string): string => {
        const trimmed = raw.trim().replace(/\s+/g, '');
        if (/^https:\/\/[^#]+\/pair#/i.test(trimmed)) return trimmed;
        const at = trimmed.indexOf('byokit-link:');
        return `https://lab.invalid/pair#${at < 0 ? trimmed : trimmed.slice(at)}`;
    };
    (globalThis as Record<string, unknown>).__MUXR_LAB_PAIR__ = async (raw: string) => {
        const grant = await pairOverLink(link(raw));
        const paired = await pairMachine({ grant });
        if (!paired.ok) throw new Error(`lab pairing activation failed: ${paired.reason}`);
        return { machineId: grant.machineId };
    };
}

if (process.env.EXPO_PUBLIC_MUXR_LAB_PAIR === '1' && Platform.OS === 'web') {
    installLabBrowserPairing();
}
