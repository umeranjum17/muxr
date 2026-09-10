import { Platform } from 'react-native';
import { TokenStorage } from '@/account';
import { getCachedConnectionSettings } from '@/connection';
import { listPairedGrants } from '@/pairing/e2ee';
import { demoClient } from './demoClient';
import { activateDemoTransport as activate } from './demoTransport';
import { isDemoPathname } from './demoGuard';

/**
 * Web demo runtime. Ephemeral by construction: read-only checks against
 * stored credentials/grants (never writes TokenStorage, IndexedDB grants,
 * push, mic, or network), allowed only on the unpaired /demo route. The
 * deterministic backend is already selected at the sync/terminal seams by
 * pathname; this gate decides whether the route may show it.
 */
export async function ensureDemoRuntime(): Promise<boolean> {
    if (Platform.OS !== 'web' || !isDemoPathname()) return false;
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
