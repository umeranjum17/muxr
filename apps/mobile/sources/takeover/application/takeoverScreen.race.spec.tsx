import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * The takeover screen's startup races: a failed attach must leave a Retry
 * (not a spinner), an enable that lands after the screen left must be
 * balanced by a disable, and a conflict dialog answered after leaving must
 * not reconnect.
 */
const act = TestRenderer.act;
const harness = vi.hoisted(() => ({
    bash: [] as string[],
    enableGate: null as (() => void) | null,
    openImpl: (async () => ({ close: () => undefined })) as (...args: unknown[]) => Promise<unknown>,
    confirmGate: null as ((value: boolean) => void) | null,
}));

vi.mock('react-native', () => ({
    View: 'View', Image: 'Image', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', TextInput: 'TextInput',
    Keyboard: { dismiss: () => undefined }, Platform: { OS: 'web' },
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: '#fff', textSecondary: '#999', textDestructive: '#f00', textLink: '#08f', surface: '#111', groupped: { background: '#000' } } } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'pp_1', port: '9222' }) }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { confirm: () => new Promise<boolean>((resolve) => { harness.confirmGate = resolve; }), alert: () => undefined } }));
vi.mock('@/catalog/ops', () => ({
    machineBash: (_: string, command: string) => {
        harness.bash.push(command);
        if (command.includes('stream enable')) return new Promise((resolve) => { harness.enableGate = () => resolve({ success: true }); });
        return Promise.resolve({ success: true });
    },
}));
vi.mock('@/catalog/store', () => ({ useSession: () => ({ metadata: { path: '/w' } }), useSocketStatus: () => ({ status: 'connected' }) }));
vi.mock('@/components/useWebImeComposing', () => ({ useWebImeComposing: () => ({ current: false }) }));
vi.mock('@/takeover', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../domain/coordinates')),
    ...(await vi.importActual<Record<string, unknown>>('../domain/textEdits')),
    parseStreamFrame: () => undefined,
    touchMessage: () => '', keyMessage: () => '', wheelMessage: () => '', codeForKey: () => '',
    isTakeoverConflict: (error: unknown) => error instanceof Error && error.message.includes('controlled by another device'),
    openTakeover: (...args: unknown[]) => harness.openImpl(...args),
}));

import TakeoverScreen from '@/app/(app)/session/[id]/takeover';

const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const textOf = (renderer: ReturnType<typeof TestRenderer.create>) => JSON.stringify((renderer as unknown as { toJSON: () => unknown }).toJSON());

beforeEach(() => { harness.bash = []; harness.enableGate = null; harness.confirmGate = null; });

describe('takeover startup races', () => {
    it('shows Retry with the spinner gone when the attach fails', async () => {
        harness.openImpl = async () => { throw new Error('network failure'); };
        let renderer!: ReturnType<typeof TestRenderer.create>;
        await act(async () => { renderer = TestRenderer.create(<TakeoverScreen />); });
        await act(async () => { harness.enableGate!(); await settle(); });
        const text = textOf(renderer);
        expect(text).toContain('Retry takeover');
        expect(text).not.toContain('Connecting to the browser stream');
    });

    it('balances an enable that completes after the screen left', async () => {
        harness.openImpl = async () => ({ close: () => undefined });
        let renderer!: ReturnType<typeof TestRenderer.create>;
        await act(async () => { renderer = TestRenderer.create(<TakeoverScreen />); });
        await act(async () => { renderer.unmount(); });
        await act(async () => { harness.enableGate!(); await settle(); });
        expect(harness.bash.filter((c) => c.includes('stream enable')).length).toBe(1);
        expect(harness.bash.filter((c) => c.includes('stream disable')).length).toBe(1);
    });

    it('ignores a Watch confirmation answered after leaving', async () => {
        let opens = 0;
        harness.openImpl = async () => { opens += 1; throw new Error('stream is controlled by another device'); };
        let renderer!: ReturnType<typeof TestRenderer.create>;
        await act(async () => { renderer = TestRenderer.create(<TakeoverScreen />); });
        await act(async () => { harness.enableGate!(); await settle(); });
        expect(harness.confirmGate).not.toBeNull();
        await act(async () => { renderer.unmount(); });
        await act(async () => { harness.confirmGate!(true); await settle(); });
        expect(opens).toBe(1);
        expect(harness.bash.filter((c) => c.includes('stream enable')).length).toBe(1);
    });
});
