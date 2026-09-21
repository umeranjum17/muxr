import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

import type { Signaling } from './protocol';
import { useDesktopSession, type DesktopSession } from './useDesktopSession';

/**
 * The whole promise the package makes about held state: whatever the desktop is
 * holding is released when the phone stops being in front of the user. The
 * background half of that is observed from React Native's AppState and has to
 * reach the control channel, which is what this drives end to end.
 */

const appStateListeners = new Set<(status: string) => void>();
vi.mock('react-native', () => ({
    AppState: {
        addEventListener: (_event: string, handler: (status: string) => void) => {
            appStateListeners.add(handler);
            return { remove: () => { appStateListeners.delete(handler); } };
        },
    },
}));

const sent: string[] = [];
vi.mock('./native', () => ({
    nativeDesklink: {
        createSession: () => 'native-1',
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
        addListener: () => ({ remove: () => undefined }),
    },
}));

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

async function connectedSession(): Promise<DesktopSession> {
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
    return held.current;
}

function sentKinds(): string[] {
    return sent.map((message) => (JSON.parse(message) as { kind: string }).kind);
}

describe('held input across a background transition', () => {
    it('releases a pointer that is still down when the app leaves the foreground', async () => {
        const session = await connectedSession();
        sent.length = 0;

        // A drag in progress: the button is down on the desktop.
        TestRenderer.act(() => {
            session.send({ kind: 'pointer', phase: 'down', x: 100, y: 120, button: 1 });
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
