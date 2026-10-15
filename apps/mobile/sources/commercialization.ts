import { Platform } from 'react-native';
import { loadAppConfig } from '@/catalog';

export const SETUP_COMMAND = 'muxr';

export function setupEmptyState(publicBaseUrl?: string): {
    title: string;
    command: string;
    setupUrl?: string;
    /** Where Add your computer sends the computer: the desktop app download. */
    desktopUrl?: string;
} {
    const base = publicBaseUrl?.trim().replace(/\/$/, '');
    return {
        title: 'Connect your computer',
        command: SETUP_COMMAND,
        ...(base ? { setupUrl: `${base}/setup`, desktopUrl: `${base}/desktop` } : {}),
    };
}

export function firstRestorableMachine(machines: Array<{ id?: unknown; paired?: unknown }>): string | undefined {
    const id = machines.find((machine) => machine.paired === true && typeof machine.id === 'string')?.id;
    return typeof id === 'string' ? id : undefined;
}

/**
 * The desktop app's download link, or undefined where Add your computer cannot
 * finish: a build with no public site has no link, and a browser cannot pair
 * with the desktop app, which offers only phone (native) codes.
 */
export function addComputerLink(): string | undefined {
    if (Platform.OS === 'web') return undefined;
    return setupEmptyState(loadAppConfig().publicBaseUrl).desktopUrl;
}

/** The fully open-source launch has no price, checkout, upgrade, or purchase surface. */
export function directBillingUrl(_config: { directDistribution?: boolean; publicBaseUrl?: string }): null {
    return null;
}
