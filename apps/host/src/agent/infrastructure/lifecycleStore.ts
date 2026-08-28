import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentLifecycle, LifecycleCatalog, LifecycleEvent, LifecycleReasonCode } from '@muxr/contract';
import { createPersistQueue, loadPersistedJson } from '../../platform/persistedJson.js';

interface LifecycleFile {
    revision: number;
    events: LifecycleEvent[];
    current?: Record<string, LifecycleEvent>;
}

export interface LifecycleStore {
    catalog(): LifecycleCatalog;
    current(sessionId: string): LifecycleEvent | undefined;
    latestFor(sessionId: string): LifecycleEvent | undefined;
    remove(sessionId: string): void;
    transition(sessionId: string, agentName: string, state: AgentLifecycle, reason: LifecycleReasonCode, taskTitle?: string): LifecycleEvent | undefined;
}

const MAX_EVENTS = 50;
const MAX_CURRENT = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const STATES = new Set<AgentLifecycle>(['starting', 'idle', 'working', 'blocked', 'done', 'failed', 'unknown']);

function safeTaskTitle(value: string | undefined): string | undefined {
    const clean = value?.replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (clean === undefined || clean === '' || /^(?:\/|[A-Za-z]:\\)|\b(?:token|password|secret|credential)\s*=/i.test(clean)) return undefined;
    return clean;
}

function valid(value: unknown): value is LifecycleFile {
    return typeof value === 'object' && value !== null
        && typeof (value as LifecycleFile).revision === 'number'
        && Array.isArray((value as LifecycleFile).events);
}

export function createLifecycleStore(dataDir: string, now: () => Date = () => new Date()): LifecycleStore {
    const filePath = join(dataDir, 'lifecycle-activity.json');
    const loaded = loadPersistedJson(filePath, valid, { revision: 0, events: [] });
    let revision = loaded.revision;
    let events = loaded.events.filter((event) =>
        typeof event.eventId === 'string' && typeof event.sessionId === 'string'
        && typeof event.displayName === 'string' && STATES.has(event.state)
        && (event.taskTitle === undefined || safeTaskTitle(event.taskTitle) === event.taskTitle)
        && Number.isFinite(Date.parse(event.at)) && now().getTime() - Date.parse(event.at) <= MAX_AGE_MS,
    ).slice(-MAX_EVENTS);
    const restoredCurrent = loaded.current === undefined ? events : Object.values(loaded.current);
    const current = new Map(restoredCurrent
        .filter((event) => typeof event.sessionId === 'string' && typeof event.eventId === 'string' && STATES.has(event.state))
        .sort((left, right) => left.at.localeCompare(right.at))
        .slice(-MAX_CURRENT)
        .map((event) => [event.sessionId, event]));
    const persist = createPersistQueue(filePath);

    function save(): void {
        revision += 1;
        persist.schedule({ revision, events, current: Object.fromEntries(current) });
    }

    return {
        catalog() {
            const current = events.filter((event) => now().getTime() - Date.parse(event.at) <= MAX_AGE_MS);
            if (current.length !== events.length) {
                events = current;
                save();
            }
            return { revision, events: [...events].reverse() };
        },
        current(sessionId) {
            return current.get(sessionId);
        },
        latestFor(sessionId) {
            return current.get(sessionId);
        },
        remove(sessionId) {
            if (current.delete(sessionId)) save();
        },
        transition(sessionId, agentName, state, reason, taskTitle) {
            taskTitle = safeTaskTitle(taskTitle);
            const previous = this.current(sessionId);
            if (previous?.state === state && previous.reasonCode === reason && previous.displayName === agentName) {
                if (previous.taskTitle !== taskTitle) {
                    const updated = { ...previous };
                    if (taskTitle === undefined) delete updated.taskTitle;
                    else updated.taskTitle = taskTitle;
                    current.set(sessionId, updated);
                    save();
                }
                return undefined;
            }
            const event: LifecycleEvent = {
                eventId: randomUUID(),
                sessionId,
                displayName: agentName,
                ...(taskTitle === undefined ? {} : { taskTitle }),
                state,
                reasonCode: reason,
                reason,
                at: now().toISOString(),
            };
            events = [...events, event]
                .filter((item) => now().getTime() - Date.parse(item.at) <= MAX_AGE_MS)
                .slice(-MAX_EVENTS);
            current.delete(sessionId);
            current.set(sessionId, event);
            if (current.size > MAX_CURRENT) {
                const removable = [...current].find(([, item]) => item.state === 'done' || item.state === 'failed' || item.state === 'unknown') ?? current.entries().next().value;
                if (removable !== undefined) current.delete(removable[0]);
            }
            save();
            return event;
        },
    };
}
