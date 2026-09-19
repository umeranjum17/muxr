import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { ConnectionSupport } from './ConnectionSupport';

/*
 * Flow test for the install-context row on the versions card: it must name the
 * real runtime — native installed app, installed standalone PWA, or an
 * ordinary browser tab — from display-mode signals only, never from viewport
 * width. Item/ItemGroup are stubbed at their module seam; the detection and
 * the row wiring are the real component.
 */

let platformOs: 'android' | 'web' = 'android';

const theme = vi.hoisted(() => ({
    colors: {
        text: '#000',
        textSecondary: '#555',
        box: { warning: { border: '#a00' } },
    },
}));

vi.mock('react-native', () => ({
    Platform: { get OS() { return platformOs; }, select: (options: Record<string, unknown>) => options.default },
    View: 'View',
    Text: 'Text',
    ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: (theme: unknown) => unknown) => styles(theme) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/catalog/store', () => ({ useLocalSettingMutable: () => [false, vi.fn()] }));
vi.mock('@/catalog', () => ({ loadAppConfig: () => ({}) }));
vi.mock('@/catalog/diagnostics', () => ({ formatConnectionDiagnosticsForReport: () => 'diagnostics' }));
vi.mock('@/utils/appVersion', () => ({ getAppVersion: () => '0.1.28', getAppBuildNumber: () => '42' }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./useHostUpdate', () => ({ useHostUpdate: () => ({ message: undefined, busy: false, check: vi.fn() }) }));
vi.mock('@/pairing', () => ({ useDeviceAuthority: () => ({ authority: 'control', loading: false }) }));
vi.mock('@/components/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('Item', props) }));
vi.mock('@/components/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children: React.ReactNode; title?: string }) => React.createElement('ItemGroup', { title }, children),
}));

let rendered: any;

const renderCard = () => {
    TestRenderer.act(() => {
        rendered = TestRenderer.create(React.createElement(ConnectionSupport, { hostVersion: undefined }));
    });
};

const installRow = () => rendered.root
    .findAll((node: any) => node.type === 'Item')
    .find((node: any) => ['Installed app', 'Installed web app', 'Web app'].includes(node.props.title as string));

const setNavigator = (value: unknown) => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
};

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
    if (rendered) TestRenderer.act(() => rendered.unmount());
    delete (globalThis as { window?: unknown }).window;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});

describe('ConnectionSupport install-context row', () => {
    it('native build renders the installed app row', () => {
        platformOs = 'android';
        renderCard();
        expect(installRow()?.props.title).toBe('Installed app');
        expect(installRow()?.props.subtitle).toBe('Version 0.1.28 · build 42');
    });

    it('installed standalone PWA is detected by the display-mode media query', () => {
        platformOs = 'web';
        (globalThis as { window?: unknown }).window = {
            matchMedia: (query: string) => ({ matches: query.includes('display-mode: standalone') }),
        };
        renderCard();
        expect(installRow()?.props.title).toBe('Installed web app');
    });

    it('iOS home-screen web app is detected by navigator.standalone', () => {
        platformOs = 'web';
        setNavigator({ standalone: true });
        renderCard();
        expect(installRow()?.props.title).toBe('Installed web app');
    });

    it('ordinary browser tab renders the web app row whatever the window width', () => {
        platformOs = 'web';
        (globalThis as { window?: unknown }).window = {
            innerWidth: 270,
            matchMedia: () => ({ matches: false }),
        };
        renderCard();
        expect(installRow()?.props.title).toBe('Web app');
    });
});
