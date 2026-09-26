import { Platform } from 'react-native';
import type { StoredHostedGrant } from '../application/linkPairing';
import { cachedGrant, loadGrants } from './grantStore';
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

export function deviceAuthority(machineId: string, grant: StoredHostedGrant | undefined): 'control' | 'observe' {
    if (Platform.OS !== 'web') return 'control';
    return grant?.machineId === machineId ? grant.authority : 'observe';
}

export function initialDeviceAuthority(machineId: string): { authority: 'control' | 'observe'; loading: boolean } {
    return { authority: deviceAuthority(machineId, cachedGrant(machineId)), loading: Platform.OS === 'web' };
}

export async function loadDeviceAuthorityGrants(): Promise<StoredHostedGrant[]> {
    return Platform.OS === 'web' ? Object.values(await loadGrants()) : [];
}

export function pairingConsentCopy(): { confirmation: string; comparison: (words: string) => string } {
    const browser = Platform.OS === 'web';
    return {
        confirmation: browser
            ? 'This browser will receive the access shown on the pairing screen. Only continue if you just ran `muxr pair --browser` on that computer.'
            : 'This phone will be able to read and type into every agent terminal on that computer, answer approvals, and start or stop agents as the user who launched muxr.\n\nOnly continue if you just ran `muxr pair` there.',
        comparison: (words) => `The computer is deciding whether to pair this ${browser ? 'browser' : 'phone'}.\n\nIt shows: ${words}\n\nIt should only be approved if these words match what it displays.`,
    };
}
