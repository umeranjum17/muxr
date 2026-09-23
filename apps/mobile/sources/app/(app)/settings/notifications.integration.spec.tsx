import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ level: 'all' as 'off' | 'important' | 'all', listeners: new Set<() => void>() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { addEventListener: () => ({ remove() {} }) }, Linking: {} }));
vi.mock('expo-application', () => ({ applicationId: null }));
vi.mock('expo-notifications', () => ({}));
vi.mock('@/catalog/store', () => ({
    storage: { getState: () => ({ localSettings: { lifecycleNotificationLevel: state.level } }) },
    useLocalSettingMutable: () => [
        React.useSyncExternalStore(
            (listener) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
            () => state.level,
        ),
        (level: typeof state.level) => { state.level = level; for (const listener of state.listeners) listener(); },
    ],
}));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ mode: 'hosted', machineId: 'machine', relayUrl: 'wss://relay.test', token: '' }) }));
vi.mock('@/pairing/e2ee', () => ({ getCachedHostedGrant: () => ({ credential: 'credential' }) }));
vi.mock('@/utils/microphonePermissions', () => ({ requestNotificationPermission: vi.fn() }));
vi.mock('@/utils/nativePushNotifications', () => ({ registerNativePushNotifications: vi.fn(), updateNativePushNotificationLevel: vi.fn() }));
vi.mock('@/../modules/voice-overlay', () => ({
    supportsPromotedNotifications: () => false,
    canPostPromotedNotifications: () => false,
    openBackgroundActivitySettings: vi.fn(),
    openPromotedNotificationSettings: vi.fn(),
}));
vi.mock('@/settings', () => ({ browserNotificationSummary: (browser: string) => browser }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));
vi.mock('@/components/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('Item', props, props.rightElement as React.ReactNode) }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: (props: Record<string, unknown>) => React.createElement('ItemGroup', props, props.children as React.ReactNode) }));
vi.mock('@/components/ItemList', () => ({ ItemList: (props: Record<string, unknown>) => React.createElement('ItemList', props, props.children as React.ReactNode) }));
vi.mock('@/components/Switch', () => ({ Switch: (props: Record<string, unknown>) => React.createElement('Switch', props) }));

import NotificationSettingsScreen from './notifications';
import { updateWebPushNotificationLevel } from '@/utils/pushNotifications';

let rendered: TestRenderer.ReactTestRenderer | undefined;

afterEach(() => {
    if (rendered) TestRenderer.act(() => rendered?.unmount());
    rendered = undefined;
    vi.unstubAllGlobals();
    state.listeners.clear();
});

it('keeps the visible switches, relay order, and worker admission in sync', async () => {
    state.level = 'all';
    const entries = new Map<string, Response>();
    const cache = {
        put: async (key: string, response: Response) => { entries.set(key, response); },
        match: async (key: string) => entries.get(key)?.clone(),
    };
    vi.stubGlobal('caches', { open: async () => cache });
    let subscription: {
        endpoint: string;
        toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
        unsubscribe: () => Promise<boolean>;
    } | null = null;
    const createSubscription = () => ({
        endpoint: 'https://push.test/endpoint',
        toJSON: () => ({ endpoint: 'https://push.test/endpoint', keys: { p256dh: 'key', auth: 'auth' } }),
        unsubscribe: async () => { subscription = null; return true; },
    });
    subscription = createSubscription();
    const registration = { pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => { subscription = createSubscription(); return subscription; },
    } };
    vi.stubGlobal('navigator', { serviceWorker: {
        getRegistration: async () => registration,
        register: async () => registration,
        ready: Promise.resolve(registration),
    } });
    vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
    vi.stubGlobal('atob', () => '\u0001');

    const posts: string[] = [];
    let release!: (response: Response) => void;
    let defer = true;
    let failRegistration = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (!init?.method) return new Response(JSON.stringify({ publicKey: 'AQ' }), { status: 200 });
        if (init.method === 'DELETE') return new Response(null, { status: 200 });
        const level = (JSON.parse(String(init.body)) as { level: string }).level;
        posts.push(level);
        if (failRegistration) return new Response(null, { status: 503 });
        if (defer) {
            defer = false;
            return await new Promise<Response>((resolve) => { release = resolve; });
        }
        return new Response(null, { status: 200 });
    }));

    await TestRenderer.act(async () => { rendered = TestRenderer.create(React.createElement(NotificationSettingsScreen)); });
    const switchFor = (name: string) => rendered!.root.findAllByType('Switch').find((item) => item.props.accessibilityLabel === name)!;
    const failedNote = () => rendered!.root.findAllByType('ItemGroup').some((group) => group.props.footer === "Couldn't update — try again");

    let off!: Promise<void>;
    TestRenderer.act(() => { off = switchFor('An agent needs you').props.onValueChange(false); });
    await vi.waitFor(() => expect(posts).toEqual(['off']));
    expect(state.level).toBe('off');

    const listeners: Record<string, (event: any) => void> = {};
    const shown = vi.fn(async () => {});
    vm.runInNewContext(readFileSync(new URL('../../../../public/sw.js', import.meta.url), 'utf8'), {
        self: { addEventListener: (name: string, listener: (event: any) => void) => { listeners[name] = listener; }, registration: { showNotification: shown } },
        caches: { open: async () => cache },
    });
    let finished!: Promise<void>;
    listeners.push({ data: { json: () => ({ kind: 'blocked', title: 'Should not appear' }) }, waitUntil: (promise: Promise<void>) => { finished = promise; } });
    await finished;
    expect(shown).not.toHaveBeenCalled();

    release(new Response(null, { status: 503 }));
    await TestRenderer.act(async () => { await off; });
    expect(state.level).toBe('all');
    expect(switchFor('An agent needs you').props.value).toBe(true);
    expect(failedNote()).toBe(true);

    defer = true;
    const first = updateWebPushNotificationLevel('important');
    await vi.waitFor(() => expect(posts).toEqual(['off', 'important']));
    const superseded = updateWebPushNotificationLevel('off');
    const latest = updateWebPushNotificationLevel('all');
    expect(posts).toEqual(['off', 'important']);
    release(new Response(null, { status: 200 }));
    await Promise.all([first, superseded, latest]);
    expect(posts).toEqual(['off', 'important', 'all']);

    await TestRenderer.act(async () => { await switchFor('Browser notifications').props.onValueChange(false); });
    expect(switchFor('Browser notifications').props.value).toBe(false);
    failRegistration = true;
    await TestRenderer.act(async () => { await switchFor('Browser notifications').props.onValueChange(true); });
    expect(switchFor('Browser notifications').props.value).toBe(false);
    expect(subscription).toBeNull();
    expect(failedNote()).toBe(true);
});
