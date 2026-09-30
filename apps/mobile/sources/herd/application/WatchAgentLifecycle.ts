function getObjectValue(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return (value as Record<string, unknown>)[key];
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function normalizeNotificationData(data: unknown): unknown {
    if (typeof data === 'string') {
        return parseJson(data);
    }
    return data;
}

function getSessionRouteFromUrl(url: string): `/session/${string}` | null {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return null;
    }

    const match = trimmedUrl.match(/(?:^|\/)session\/([^/?#]+)/);
    if (!match) {
        return null;
    }

    const encodedSessionId = match[1];
    const sessionId = (() => {
        try {
            return decodeURIComponent(encodedSessionId);
        } catch {
            return encodedSessionId;
        }
    })();

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
        return null;
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`;
}

export function getSessionRouteFromNotificationData(data: unknown): `/session/${string}` | null {
    const normalizedData = normalizeNotificationData(data);
    if (!normalizedData || typeof normalizedData !== 'object' || Array.isArray(normalizedData)) {
        return null;
    }

    const url = getObjectValue(normalizedData, 'url');
    if (typeof url === 'string') {
        const routeFromUrl = getSessionRouteFromUrl(url);
        if (routeFromUrl) {
            return routeFromUrl;
        }
    }

    const sessionId = getObjectValue(normalizedData, 'sessionId');
    if (typeof sessionId !== 'string') {
        return null;
    }

    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
        return null;
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`;
}

export type WatchAgentLifecycleCommand = { notificationData: unknown; activeMachineId: string };

export type WatchAgentLifecycleResult = { agentRoute: string | null; selectMachine: boolean };

/** Resolve a Lifecycle Event notification to the Agent Route it names. */
export function watchAgentLifecycle(command: WatchAgentLifecycleCommand): WatchAgentLifecycleResult {
    const data = normalizeNotificationData(command.notificationData);
    const machineId = getObjectValue(data, 'machineId');
    if (typeof machineId === 'string' && machineId !== command.activeMachineId) {
        return { agentRoute: null, selectMachine: true };
    }
    const route = getSessionRouteFromNotificationData(data);
    if (!route) return { agentRoute: null, selectMachine: false };
    const encoded = route.replace(/^\/session\//, '');
    try {
        return { agentRoute: decodeURIComponent(encoded), selectMachine: false };
    } catch {
        return { agentRoute: encoded, selectMachine: false };
    }
}
