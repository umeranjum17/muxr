import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

export type AppStateLike = {
    currentState: AppStateStatus;
    addEventListener: (type: 'change', listener: (state: AppStateStatus) => void) => NativeEventSubscription;
};

/**
 * Google Code Scanner runs in its own Activity. A pairing confirm shown
 * during that teardown is dropped on Android release, so the scan looks
 * successful and Home stays unpaired. Wait until muxr is foreground again.
 * Never time out into a confirm while the app is still inactive.
 */
export async function waitUntilAppActive(appState?: AppStateLike): Promise<void> {
    const source = appState ?? AppState;
    if (source.currentState === 'active') return;
    await new Promise<void>((resolve) => {
        let settled = false;
        let subscription: NativeEventSubscription | undefined;
        const finish = () => {
            if (settled) return;
            settled = true;
            subscription?.remove();
            resolve();
        };
        subscription = source.addEventListener('change', (next) => {
            if (next === 'active') finish();
        });
        // Subscribe first, then re-read: currentState can flip to active
        // between the early return and addEventListener.
        if (source.currentState === 'active') finish();
    });
}

export async function deliverScannedPairingLink(
    url: string,
    handler: (url: string) => void,
    deps: {
        dismissScanner: () => Promise<unknown>;
        appState?: AppStateLike;
    },
): Promise<void> {
    try {
        await deps.dismissScanner();
    } catch {
        // Decode already closed the scanner Activity.
    }
    await waitUntilAppActive(deps.appState);
    handler(url);
}
