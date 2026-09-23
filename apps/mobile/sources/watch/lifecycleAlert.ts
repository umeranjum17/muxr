import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

/** The Agent whose terminal is on screen, if any. */
let onScreen: string | null = null;

// One row per Agent: a newer Lifecycle Event replaces the Agent's last alert
// instead of stacking under it. Without an identifier Expo invents a new one
// for every post.
function alertId(agentRoute: string): string {
    return `agent:${agentRoute}`;
}

function dismissAlert(agentRoute: string): void {
    if (Platform.OS === 'web') return;
    void Notifications.dismissNotificationAsync(alertId(agentRoute)).catch(() => undefined);
}

/**
 * The person is looking at this Agent's terminal, so its alerts are noise:
 * clear the one already posted, clear it again whenever the app comes back to
 * this terminal, and post none while it stays in front. Returns the release.
 */
export function agentOnScreen(agentRoute: string): () => void {
    onScreen = agentRoute;
    dismissAlert(agentRoute);
    const resumed = AppState.addEventListener('change', (state) => {
        if (state === 'active') dismissAlert(agentRoute);
    });
    return () => {
        resumed.remove();
        if (onScreen === agentRoute) onScreen = null;
    };
}

/** Post an Agent's lifecycle alert unless its terminal is in front of the person. */
export async function alertAgent(agentRoute: string, title: string, body: string): Promise<void> {
    if (Platform.OS === 'web') return;
    if (onScreen === agentRoute && AppState.currentState === 'active') return;
    await Notifications.scheduleNotificationAsync({
        identifier: alertId(agentRoute),
        content: { title, body, data: { url: `/session/${encodeURIComponent(agentRoute)}` } },
        trigger: null,
    });
}
