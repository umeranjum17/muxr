import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

import type { Signaling } from './protocol';
import { useDesktopSession, type DesktopSession } from './useDesktopSession';

/** `act` refuses to flush state updates unless React is told this is a test. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The lifecycle promises the package makes on its own: held input is released
 * when the phone leaves the foreground, and a transport failure the automatic
 * reconnect cannot fix still leaves the user able to try again.
 */

type NativeSessionEvent = { sessionId: string; name: string; payload: Record<string, unknown> };

const appStateListeners = new Set<(status: string) => void>();
const nativeListeners = new Set<(event: NativeSessionEvent) => void>();
const sent: string[] = [];
let createdSessions = 0;

vi.mock('react-native', () => ({
    AppState: {
        addEventListener: (_event: string, handler: (status: string) => void) => {
            appStateListeners.add(handler);
            return { remove: () => { appStateListeners.delete(handler); } };
        },
    },
}));

vi.mock('./native', () => ({
    nativeDesklink: {
        createSession: () => `native-${++createdSessions}`,
        setRemoteDescription: () => true,
        addRemoteCandidate: () => true,
        sendControl: (_id: string, message: string) => {
            sent.push(message);
            return true;
        },
        showKeyboard: () => true,
        hideKeyboard: () => true,
        setSurfaceSize: () => true,
        closeSession: () => true,
        isAvailable: () => true,
        addListener: (_name: string, handler: (event: NativeSessionEvent) => void) => {
            nativeListeners.add(handler);
            return { remove: () => { nativeListeners.delete(handler); } };
        },
    },
}));

beforeEach(() => {
    appStateListeners.clear();
    nativeListeners.clear();
    sent.length = 0;
    createdSessions = 0;
});

function signaling(): Signaling {
    return {
        async request<T>(method: string): Promise<T> {
            if (method === 'session.open') {
                return {
                    sessionId: 'engine-1',
                    generation: 1,
                    source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
                    geometry: {
                        source: { width: 2560, height: 1440 },
                        encoded: { width: 1280, height: 720 },
                        origin: { x: 0, y: 0 },
                    },
                } as T;
            }
            return { accepted: true } as T;
        },
        subscribe: () => () => undefined,
    };
}

async function connectedSession(): Promise<{ current: DesktopSession }> {
    const held: { current: DesktopSession | null } = { current: null };
    function Harness() {
        held.current = useDesktopSession({
            authorize: async () => ({ signaling: signaling(), session: { permissions: ['view', 'control'] } }),
        });
        return null;
    }
    await TestRenderer.act(async () => {
        TestRenderer.create(React.createElement(Harness));
    });
    await TestRenderer.act(async () => {
        await held.current?.connect();
    });
    if (held.current === null) throw new Error('the hook did not mount');
    // The hook returns a new object per render, so tests read the live one.
    return held as { current: DesktopSession };
}

function nativeEvent(name: string, sessionId: string | null): void {
    TestRenderer.act(() => {
        for (const listener of [...nativeListeners]) {
            listener({ sessionId: sessionId ?? '', name, payload: {} });
        }
    });
}

function sentKinds(): string[] {
    return sent.map((message) => (JSON.parse(message) as { kind: string }).kind);
}

describe('control messages', () => {
    it('leaves the sequence to the platform so input and app messages share one counter', async () => {
        const session = await connectedSession();
        sent.length = 0;

        TestRenderer.act(() => {
            session.current.send({ kind: 'pointer', phase: 'down', x: 10, y: 10, button: 1 });
        });
        TestRenderer.act(() => {
            session.current.releaseHeld();
        });

        const messages = sent.map((message) => JSON.parse(message) as Record<string, unknown>);
        expect(messages.map((message) => message.kind)).toEqual(['pointer', 'release_all']);
        // A seq stamped here would collide with the native input counter the
        // engine already holds.
        expect(messages.every((message) => message.seq === undefined)).toBe(true);
    });
});

describe('held input across a background transition', () => {
    it('releases a pointer that is still down when the app leaves the foreground', async () => {
        const session = await connectedSession();
        sent.length = 0;

        // A drag in progress: the button is down on the desktop.
        TestRenderer.act(() => {
            session.current.send({ kind: 'pointer', phase: 'down', x: 100, y: 120, button: 1 });
        });
        expect(sentKinds()).toEqual(['pointer']);

        // Still in the foreground: nothing is released.
        TestRenderer.act(() => {
            for (const listener of appStateListeners) listener('active');
        });
        expect(sentKinds()).toEqual(['pointer']);

        // Backgrounded: the desktop must not keep the button held.
        TestRenderer.act(() => {
            for (const listener of appStateListeners) listener('background');
        });
        expect(sentKinds()).toEqual(['pointer', 'release_all']);
    });
});

describe('a transport failure the automatic reconnect cannot fix', () => {
    it('lets the user try again instead of holding a dead session', async () => {
        const session = await connectedSession();
        const first = session.current.nativeId;
        expect(first).not.toBeNull();

        // First failure: the hook retries once on its own.
        nativeEvent('failure', first);
        await TestRenderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 900));
        });
        await TestRenderer.act(async () => {});
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.nativeId).not.toBe(first);

        // Second failure: the retry is spent and the dead handle must not
        // survive it, or the overlay's "Try again" would be a no-op.
        nativeEvent('failure', session.current.nativeId);
        await TestRenderer.act(async () => {});
        expect(session.current.snapshot.status).toBe('failed');
        expect(session.current.nativeId).toBeNull();

        await TestRenderer.act(async () => {
            await session.current.connect();
        });
        expect(session.current.nativeId).not.toBeNull();
        expect(session.current.snapshot.status).not.toBe('failed');
    }, 20_000);
});

describe('a refusal the host makes', () => {
    it('surfaces its code and does not spend the reconnect on it', async () => {
        const held: { current: DesktopSession | null } = { current: null };
        let authorizations = 0;
        const refusal = Object.assign(
            new Error('This computer cannot inject input, so there is nothing to control.'),
            { code: 'input-unavailable' },
        );

        function Harness() {
            held.current = useDesktopSession({
                authorize: async () => {
                    authorizations += 1;
                    return {
                        signaling: {
                            async request<T>(): Promise<T> {
                                throw refusal;
                            },
                            subscribe: () => () => undefined,
                        },
                        session: { permissions: ['view', 'control'] },
                    };
                },
            });
            return null;
        }

        await TestRenderer.act(async () => {
            TestRenderer.create(React.createElement(Harness));
        });
        await TestRenderer.act(async () => {
            await held.current?.connect();
        });

        expect(held.current?.snapshot.status).toBe('failed');
        expect(held.current?.snapshot.failure).toMatchObject({ code: 'input-unavailable' });

        // A refusal a reconnect cannot fix must not consume the retry.
        await TestRenderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 900));
        });
        expect(authorizations).toBe(1);
    }, 20_000);
});

describe('a session that finishes opening after the screen was torn down', () => {
    it('closes what the host opened instead of leaving it capturing', async () => {
        const requests: string[] = [];
        let releaseOpen: (() => void) | null = null;
        const held: { current: DesktopSession | null } = { current: null };
        const signaling: Signaling = {
            async request<T>(method: string): Promise<T> {
                requests.push(method);
                if (method === 'session.open') {
                    await new Promise<void>((resolve) => { releaseOpen = resolve; });
                    return {
                        sessionId: 'engine-1',
                        generation: 1,
                        source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
                        geometry: {
                            source: { width: 2560, height: 1440 },
                            encoded: { width: 1280, height: 720 },
                            origin: { x: 0, y: 0 },
                        },
                    } as T;
                }
                return { accepted: true } as T;
            },
            subscribe: () => () => undefined,
        };

        function Harness() {
            held.current = useDesktopSession({
                authorize: async () => ({ signaling, session: { permissions: ['view', 'control'] } }),
            });
            return null;
        }

        await TestRenderer.act(async () => {
            TestRenderer.create(React.createElement(Harness));
        });

        let opening: Promise<void> | undefined;
        await TestRenderer.act(async () => {
            opening = held.current!.connect();
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(releaseOpen).not.toBeNull();

        await TestRenderer.act(async () => {
            await held.current!.close('left the desktop');
        });
        releaseOpen!();
        await TestRenderer.act(async () => { await opening; });

        expect(requests).toContain('session.close');
    }, 20_000);
});
