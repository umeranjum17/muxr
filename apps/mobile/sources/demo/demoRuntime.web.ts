import { Platform } from 'react-native';
import { TokenStorage } from '@/account';
import { getCachedConnectionSettings } from '@/connection';
import { listPairedGrants } from '@/pairing/e2ee';
import { demoClient } from './demoClient';
import { activateDemoTransport as activate } from './demoTransport';

/**
 * Web demo runtime. Ephemeral by construction: read-only checks against
 * stored credentials/grants (never writes TokenStorage, IndexedDB grants,
 * push, mic, or network), allowed only on the unpaired /demo route. The
 * deterministic backend is already selected at the sync/terminal seams by
 * pathname; this gate decides whether the route may show it.
 */
export async function ensureDemoRuntime(): Promise<boolean> {
    // The /demo route component is the only caller, so its mount is proof we
    // are on the demo route; reading window.location here instead races
    // router.push('/demo') (the History API updates a tick after the screen
    // mounts), so a button tap would read the old pathname, return false and
    // bounce home. The unpaired-only property below is what actually gates.
    if (Platform.OS !== 'web') return false;
    const [credentials, grants] = await Promise.all([
        TokenStorage.getCredentials().catch(() => null),
        listPairedGrants().catch(() => []),
    ]);
    if (credentials !== null || grants.length > 0 || getCachedConnectionSettings().machineId !== '') return false;
    return true;
}

/** Sticky per page load; only this gated route sets it. */
export function activateDemoTransport(): void {
    activate();
}

/** Re-run the recorded scenario from the top. */
export function resetDemoRuntime(): void {
    demoClient.reset();
}
