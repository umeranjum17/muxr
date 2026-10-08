import { decidePairingInput, linkOfferFromUrl, type PairArrivalSource } from '../domain/pairingString';
import { offerMatchesGrant } from '../domain/hostedGrant';
import { listPairedGrants } from './linkPairing';

/** Where an arriving offer takes the app: its consent screen, the manual form, or back to the existing pairing. */
export type PairArrivalTarget = 'home' | 'confirm' | 'form';

/**
 * The OS redelivers the pairing intent on activity recreation (density
 * change) and on relaunch paths that restore the launching intent, so one
 * offer can arrive twice. An arrival carrying the identity of a pairing this
 * device already holds (same machine, same link) restores it with no claim,
 * expired or not. Any other machine or link reaches consent as before, and
 * anything the person entered themselves — or anything unreadable — keeps
 * the manual form with the true reason. Storage failures fall back to that
 * same form rather than stranding.
 */
export async function resolvePairArrival(raw: string, args: {
    authenticated: boolean;
    source: PairArrivalSource;
}): Promise<PairArrivalTarget> {
    if (args.source === 'intent' && args.authenticated) {
        try {
            const offer = linkOfferFromUrl(raw);
            if (offer !== undefined && (await listPairedGrants()).some((grant) => offerMatchesGrant(offer, grant))) {
                return 'home';
            }
        } catch {
            // Fall through to the arrival form below.
        }
    }
    return decidePairingInput(raw).ok ? 'confirm' : 'form';
}
