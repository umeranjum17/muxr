import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { ConnectionSupport } from './ConnectionSupport';

/*
 * Flow test for the versions card: the install-context row must name the real
 * runtime — native installed app, installed standalone PWA, or an ordinary
 * browser tab — from display-mode signals only, never from viewport width, and
 * the version rows must name the running build's channel from the build's own
 * config. Item/ItemGroup are stubbed at their module seam; the detection, the
 * app config reader, the version labels and the row wiring are real.
 */

let platformOs: 'android' | 'web' = 'android';
const build = { native: '0.1.28', releaseVersion: undefined as string | undefined, variant: 'production' as string | undefined };

const theme = vi.hoisted(() => ({
    colors: {
        text: '#000',
        textSecondary: '#555',
        textLink: '#007aff',
        header: { tint: '#007aff' },
        surfaceHigh: '#eee',
        groupped: { background: '#f2f2f7', sectionTitle: '#6d6d72' },
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
vi.mock('expo-application', () => ({ get nativeApplicationVersion() { return build.native; }, nativeBuildVersion: '42' }));
vi.mock('expo-constants', () => ({ default: { get expoConfig() { return { version: build.native, extra: { app: { releaseVersion: build.releaseVersion, buildVariant: build.variant } } }; } } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('@/catalog', async () => ({ loadAppConfig: (await import('@/catalog/infrastructure/appConfig')).loadAppConfig }));
vi.mock('@/catalog/diagnostics', () => ({ formatConnectionDiagnosticsForReport: () => 'diagnostics' }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./useHostUpdate', () => ({ useHostUpdate: () => ({ message: undefined, busy: false, check: vi.fn() }) }));
vi.mock('@/pairing', () => ({ useDeviceAuthority: () => ({ authority: 'control', loading: false }) }));
vi.mock('@/components/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('Item', props) }));
vi.mock('@/components/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children: React.ReactNode; title?: string }) => React.createElement('ItemGroup', { title }, children),
}));

let rendered: any;

const renderCard = (hostVersion?: string) => {
    if (rendered) TestRenderer.act(() => rendered.unmount());
    TestRenderer.act(() => {
        rendered = TestRenderer.create(React.createElement(ConnectionSupport, { hostVersion }));
    });
};

const statusRow = () => rendered.root.findAll((node: any) => node.type === 'Item')[0];

const installRow = () => rendered.root
    .findAll((node: any) => node.type === 'Item')
    .find((node: any) => ['Installed app', 'Installed web app', 'Web app'].includes(node.props.title as string));

const setNavigator = (value: unknown) => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
};

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
    if (rendered) TestRenderer.act(() => rendered.unmount());
    rendered = undefined;
    Object.assign(build, { native: '0.1.28', releaseVersion: undefined, variant: 'production' });
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

describe('ConnectionSupport version rows', () => {
    it('names a stable, nightly, pre-release or source build and flags a host that differs', () => {
        Object.assign(build, { native: '0.2.13', releaseVersion: '0.2.13', variant: 'production' });
        renderCard('0.2.13');
        expect(statusRow()?.props.title).toBe('Check compatibility / align host');
        expect(statusRow()?.props.subtitle).toBe('App 0.2.13 · Host 0.2.13');
        expect(installRow()?.props.subtitle).toBe('Version 0.2.13 · build 42');

        // The nightly APK is a development-variant build whose release identity says nightly.
        Object.assign(build, { native: '0.2.14', releaseVersion: '0.2.14-nightly.1.1', variant: 'development' });
        renderCard('0.2.14-nightly.1.1');
        expect(statusRow()?.props.subtitle).toBe('App 0.2.14-nightly.1.1 · Host 0.2.14-nightly.1.1');

        Object.assign(build, { native: '0.2.14', releaseVersion: '0.2.14-rc.1', variant: 'production' });
        renderCard('0.2.14');
        expect(installRow()?.props.subtitle).toBe('Version 0.2.14-rc.1 pre-release · build 42');
        expect(statusRow()?.props.title).toBe('Check compatibility / align host');

        Object.assign(build, { native: '0.2.13', releaseVersion: '0.2.13', variant: 'development' });
        renderCard('0.2.10');
        expect(statusRow()?.props.title).toBe('homeNotices.versions');
        expect(statusRow()?.props.subtitle).toBe('App 0.2.13-dev · Host 0.2.10');
    });
});
