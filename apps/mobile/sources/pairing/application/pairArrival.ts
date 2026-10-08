import { decidePairingInput, linkOfferFromUrl, type PairArrivalSource } from '../domain/pairingString';
import { offerMatchesGrant, pickGrantForConnection } from '../domain/hostedGrant';
import { loadConnectionSettingsAsync } from '@/connection';
import { listPairedGrants } from './linkPairing';

/** Where an arriving offer takes the app: its consent screen, the manual form, or back to the existing pairing. */
export type PairArrivalTarget = 'home' | 'confirm' | 'form';

/**
 * The OS redelivers the pairing intent on activity recreation (density
 * change) and on relaunch paths that restore the launching intent, so one
 * offer can arrive twice. An authenticated intent matching the active grant
 * selected by pickGrantForConnection returns Home without another claim,
 * expired or not. Saved but inactive grants do not bypass consent.
 * All other arrivals, including user input and storage failures, follow
 * normal input validation: valid offers reach consent; invalid ones show
 * their reason in the manual form.
 */
export async function resolvePairArrival(raw: string, args: {
    authenticated: boolean;
    source: PairArrivalSource;
}): Promise<PairArrivalTarget> {
    if (args.source === 'intent' && args.authenticated) {
        try {
            const offer = linkOfferFromUrl(raw);
            const settings = await loadConnectionSettingsAsync();
            const grant = pickGrantForConnection(settings, await listPairedGrants());
            if (offer !== undefined && grant !== undefined && offerMatchesGrant(offer, grant)) {
                return 'home';
            }
        } catch {
            // Use normal input validation if stored identity cannot be read.
        }
    }
    return decidePairingInput(raw).ok ? 'confirm' : 'form';
}
