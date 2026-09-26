import { Platform } from 'react-native';
import type { StoredHostedGrant } from '../application/linkPairing';
import { isBrowserLinkOffer } from './linkPairClient';

export function pairingDeviceName(): string {
    if (Platform.OS === 'ios') return 'iPhone';
    if (Platform.OS === 'android') return 'Android phone';
    return 'Browser';
}

export function assertSupportedOffer(scanned: string): void {
    if (Platform.OS === 'web' && !isBrowserLinkOffer(scanned)) {
        throw new Error('Native pairing codes are for phones. Use a fresh browser link from `muxr pair --browser` on the computer.');
    }
}

export function requiresStoredAuthority(): boolean {
    return Platform.OS === 'web';
}

export function deviceAuthority(machineId: string, grant: StoredHostedGrant | undefined): 'control' | 'observe' {
    if (!requiresStoredAuthority()) return 'control';
    return grant?.machineId === machineId ? grant.authority : 'observe';
}
