import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ level: 'all' as 'off' | 'important' | 'all', machineId: 'machine', listeners: new Set<() => void>() }));
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
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ mode: 'hosted', machineId: state.machineId, relayUrl: 'wss://relay.test', token: '' }) }));
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

import NotificationSettingsScreen from '../app/(app)/settings/notifications';
import { refreshPushState, updateWebPushNotificationLevel } from '@/utils/pushNotifications';
import { setActiveSessionClient } from '@/connection/sessionClientRef';

let rendered: ReturnType<typeof TestRenderer.create> | undefined;

afterEach(() => {
    if (rendered) TestRenderer.act(() => rendered?.unmount());
    rendered = undefined;
    vi.unstubAllGlobals();
    setActiveSessionClient(undefined);
    state.listeners.clear();
});

it('keeps the visible switches, relay order, and worker admission in sync', async () => {
    state.level = 'all';
    state.machineId = 'machine';
    const confirmed = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => confirmed.get(key) ?? null,
        setItem: (key: string, value: string) => { confirmed.set(key, value); },
        removeItem: (key: string) => { confirmed.delete(key); },
    });
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
    confirmed.set('muxr.webPush.confirmed.machine', subscription.endpoint);
    let queryFails = false;
    const registration = { pushManager: {
        getSubscription: async () => { if (queryFails) throw new Error('push query failed'); return subscription; },
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
    let release!: (ok: boolean) => void;
    let defer = true;
    let failRegistration = false;
    setActiveSessionClient({
        isLive: () => true,
        request: async (type: string, params: { level?: string }) => {
            if (type === 'push.vapid') return { publicKey: 'AQ' };
            if (type !== 'push.subscribe') return null;
            posts.push(params.level!);
            if (failRegistration) throw new Error('registration failed');
            if (defer) {
                defer = false;
                if (!await new Promise<boolean>((resolve) => { release = resolve; })) throw new Error('registration failed');
            }
            return null;
        },
    } as never);

    await TestRenderer.act(async () => { rendered = TestRenderer.create(React.createElement(NotificationSettingsScreen)); });
    const rows = (type: string) => (rendered!.root as { findAllByType(type: string): { props: any }[] }).findAllByType(type);
    const switchFor = (name: string) => rows('Switch').find((item) => item.props.accessibilityLabel === name)!;
    const failedNote = () => rows('ItemGroup').some((group) => group.props.footer === "Couldn't update — try again");

    let off!: Promise<void>;
    TestRenderer.act(() => { off = switchFor('An agent needs you').props.onValueChange(false); });
    await vi.waitFor(() => expect(posts).toEqual(['off']));
    expect(state.level).toBe('off');

    const listeners: Record<string, (event: any) => void> = {};
    const shown = vi.fn(async () => {});
    let cacheFailure: 'open' | 'match' | 'text' | null = null;
    vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
        self: { addEventListener: (name: string, listener: (event: any) => void) => { listeners[name] = listener; }, registration: { showNotification: shown } },
        caches: { open: async () => {
            if (cacheFailure === 'open') throw new Error('cache open failed');
            return { match: async (key: string) => {
                if (cacheFailure === 'match') throw new Error('cache match failed');
                if (cacheFailure === 'text') return { text: async () => { throw new Error('cache text failed'); } };
                return cache.match(key);
            } };
        } },
    });
    const receive = async (kind: string) => {
        let finished!: Promise<void>;
        listeners.push({ data: { json: () => ({ kind, title: kind }) }, waitUntil: (promise: Promise<void>) => { finished = promise; } });
        await finished;
    };
    await receive('blocked');
    expect(shown).not.toHaveBeenCalled();
    entries.delete('/muxr-push-level');
    await receive('blocked');
    expect(shown).toHaveBeenCalledOnce();
    await cache.put('/muxr-push-level', new Response('off'));
    let expectedNotifications = 1;
    for (const failure of ['open', 'match', 'text'] as const) {
        cacheFailure = failure;
        await receive('blocked').catch(() => undefined);
        expect(shown).toHaveBeenCalledTimes(++expectedNotifications);
    }
    cacheFailure = null;
    await receive('blocked');
    expect(shown).toHaveBeenCalledTimes(4);

    release(false);
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
    release(true);
    await Promise.all([first, superseded, latest]);
    expect(posts).toEqual(['off', 'important', 'all']);

    queryFails = true;
    expect(await refreshPushState()).not.toBe('unsubscribed');
    await TestRenderer.act(async () => { await switchFor('An agent needs you').props.onValueChange(false); });
    expect(state.level).toBe('all');
    expect(failedNote()).toBe(true);
    queryFails = false;

    failRegistration = true;
    state.machineId = 'other-machine';
    expect(await updateWebPushNotificationLevel('all')).toBe(false);
    expect(await refreshPushState()).not.toBe('subscribed');
    await TestRenderer.act(async () => { rendered?.unmount(); rendered = TestRenderer.create(React.createElement(NotificationSettingsScreen)); });
    await vi.waitFor(() => expect(failedNote()).toBe(true));
    expect(switchFor('Browser notifications').props.value).toBe(false);
    expect(subscription).not.toBeNull();

    failRegistration = false;
    await TestRenderer.act(async () => { rendered?.unmount(); rendered = TestRenderer.create(React.createElement(NotificationSettingsScreen)); });
    await vi.waitFor(() => expect(switchFor('Browser notifications').props.value).toBe(true));
    expect(await refreshPushState()).toBe('subscribed');

    await TestRenderer.act(async () => { await switchFor('Browser notifications').props.onValueChange(false); });
    expect(switchFor('Browser notifications').props.value).toBe(false);
    failRegistration = true;
    await TestRenderer.act(async () => { await switchFor('Browser notifications').props.onValueChange(true); });
    expect(switchFor('Browser notifications').props.value).toBe(false);
    expect(subscription).toBeNull();
    expect(failedNote()).toBe(true);

    failRegistration = false;
    entries.delete('/muxr-push-level');
    await TestRenderer.act(async () => { await switchFor('Browser notifications').props.onValueChange(true); });
    expect(switchFor('Browser notifications').props.value).toBe(true);
    expect(await (await cache.match('/muxr-push-level'))?.text()).toBe('all');
});
