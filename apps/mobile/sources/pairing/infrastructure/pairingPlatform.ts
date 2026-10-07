import { Platform } from 'react-native';
import type { StoredHostedGrant } from '../application/linkPairing';
import { cachedGrant, loadGrants } from './grantStore';
import { isBrowserLinkOffer } from './linkPairClient';
import { decidePairingInput, PairingNeedsNewCode } from '../domain/pairingString';

/** What this device calls itself in pairing copy: an iPad is never "this phone". */
export function pairingDeviceNoun(): 'browser' | 'iPad' | 'iPhone' | 'phone' {
    if (Platform.OS === 'web') return 'browser';
    if (Platform.OS === 'ios') return Platform.isPad ? 'iPad' : 'iPhone';
    return 'phone';
}

export function pairingDeviceName(): string {
    const noun = pairingDeviceNoun();
    if (noun === 'phone') return 'Android phone';
    return noun === 'browser' ? 'Browser' : noun;
}

export function assertSupportedOffer(scanned: string): void {
    if (Platform.OS === 'web' && !isBrowserLinkOffer(scanned)) {
        throw new PairingNeedsNewCode('Native pairing codes are for phones. Use a fresh browser link from `muxr pair --browser` on the computer.');
    }
    const decided = decidePairingInput(scanned);
    if (!decided.ok) throw new PairingNeedsNewCode(decided.message);
}

export function deviceAuthority(machineId: string, grant: StoredHostedGrant | undefined): 'control' | 'observe' {
    if (Platform.OS !== 'web') return 'control';
    return grant?.machineId === machineId ? grant.authority ?? 'observe' : 'observe';
}

export function initialDeviceAuthority(machineId: string): { authority: 'control' | 'observe'; loading: boolean } {
    return { authority: deviceAuthority(machineId, cachedGrant(machineId)), loading: Platform.OS === 'web' };
}

export async function loadDeviceAuthorityGrants(): Promise<StoredHostedGrant[]> {
    return Platform.OS === 'web' ? Object.values(await loadGrants()) : [];
}

export function pairingDeviceKind(): 'phone' | 'browser' {
    return Platform.OS === 'web' ? 'browser' : 'phone';
}
