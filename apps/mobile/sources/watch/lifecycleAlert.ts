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

/** A blocked Agent's alert: Open lands on its prompt, Answer replies from the notification. */
export const QUESTION_CATEGORY = 'agent-question';
export const OPEN_ACTION = 'open';
export const ANSWER_ACTION = 'answer';

if (Platform.OS !== 'web') {
    void Notifications.setNotificationCategoryAsync(QUESTION_CATEGORY, [
        { identifier: OPEN_ACTION, buttonTitle: 'Open', options: { opensAppToForeground: true } },
        {
            identifier: ANSWER_ACTION,
            buttonTitle: 'Answer',
            textInput: { submitButtonTitle: 'Send', placeholder: 'y, n or a choice number' },
            // iOS suspends a background app before the reply leaves; there it opens muxr.
            options: { opensAppToForeground: Platform.OS === 'ios' },
        },
    ]).catch(() => undefined);
}

/**
 * Post an Agent's lifecycle alert unless its terminal is in front of the
 * person. `question` names the blocked event an Answer may reply to.
 */
export async function alertAgent(agentRoute: string, title: string, body: string, question?: { eventId: string }): Promise<void> {
    if (Platform.OS === 'web') return;
    await orderedAlert(agentRoute, async () => {
        if (focusedAgentRoute() === agentRoute) return;
        await Notifications.scheduleNotificationAsync({
            identifier: alertId(agentRoute),
            content: {
                title,
                body,
                data: {
                    url: `/session/${encodeURIComponent(agentRoute)}`,
                    ...(question === undefined ? {} : { sessionId: agentRoute, eventId: question.eventId }),
                },
                ...(question === undefined ? {} : { categoryIdentifier: QUESTION_CATEGORY }),
            },
            trigger: null,
        });
    });
}

/**
 * An answered alert goes away; one whose answer failed says why instead, so
 * the reply field never hangs waiting. Either only while the alert still shows
 * the question that was answered: a newer one for the Agent stays put.
 */
export async function settleAnsweredAlert(response: Notifications.NotificationResponse, failure?: string): Promise<void> {
    if (Platform.OS === 'web') return;
    const { identifier, content } = response.notification.request;
    const presented = (await Notifications.getPresentedNotificationsAsync())
        .find((notification) => notification.request.identifier === identifier);
    if (presented !== undefined && presented.request.content.data?.eventId !== content.data?.eventId) return;
    if (failure === undefined) {
        await Notifications.dismissNotificationAsync(identifier);
        return;
    }
    await Notifications.scheduleNotificationAsync({
        identifier,
        content: { title: content.title ?? 'muxr', body: failure, data: content.data ?? {} },
        trigger: null,
    });
}
