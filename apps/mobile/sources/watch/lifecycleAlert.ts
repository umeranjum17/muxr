import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

/** The Agent whose terminal is on screen, if any. */
let onScreen: string | null = null;
const focusListeners = new Set<() => void>();
const alertOperations = new Map<string, Promise<void>>();

export function focusedAgentRoute(): string | null {
    return AppState.currentState === 'active' ? onScreen : null;
}

export function subscribeFocusedAgent(listener: () => void): () => void {
    focusListeners.add(listener);
    return () => { focusListeners.delete(listener); };
}

function notifyFocus(): void {
    for (const listener of focusListeners) listener();
}

export function notificationResponseKey(notification: Notifications.Notification): string {
    return `${notification.request.identifier}:${notification.date}`;
}

// One row per Agent: a newer Lifecycle Event replaces the Agent's last alert
// instead of stacking under it. Without an identifier Expo invents a new one
// for every post.
function alertId(agentRoute: string): string {
    return `agent:${agentRoute}`;
}

function orderedAlert(agentRoute: string, operation: () => Promise<void>): Promise<void> {
    const next = (alertOperations.get(agentRoute) ?? Promise.resolve()).then(operation);
    const settled = next.catch(() => undefined);
    alertOperations.set(agentRoute, settled);
    void settled.then(() => {
        if (alertOperations.get(agentRoute) === settled) alertOperations.delete(agentRoute);
    });
    return next;
}

function dismissAlert(agentRoute: string): void {
    if (Platform.OS === 'web') return;
    void orderedAlert(agentRoute, () => Notifications.dismissNotificationAsync(alertId(agentRoute))).catch(() => undefined);
}

/**
 * The person is looking at this Agent's terminal, so its alerts are noise:
 * clear the one already posted, clear it again whenever the app comes back to
 * this terminal, and post none while it stays in front. Returns the release.
 */
export function agentOnScreen(agentRoute: string): () => void {
    onScreen = agentRoute;
    notifyFocus();
    dismissAlert(agentRoute);
    const resumed = AppState.addEventListener('change', (state) => {
        notifyFocus();
        if (state === 'active' && onScreen === agentRoute) dismissAlert(agentRoute);
    });
    return () => {
        resumed.remove();
        if (onScreen === agentRoute) {
            onScreen = null;
            notifyFocus();
        }
    };
}

export function dismissAgentAlert(agentRoute: string): void {
    dismissAlert(agentRoute);
}

/** Post an Agent's lifecycle alert unless its terminal is in front of the person. */
export async function alertAgent(agentRoute: string, title: string, body: string): Promise<void> {
    if (Platform.OS === 'web') return;
    await orderedAlert(agentRoute, async () => {
        if (focusedAgentRoute() === agentRoute) return;
        await Notifications.scheduleNotificationAsync({
            identifier: alertId(agentRoute),
            content: { title, body, data: { url: `/session/${encodeURIComponent(agentRoute)}` } },
            trigger: null,
        });
    });
}
