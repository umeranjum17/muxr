import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Flow test for the browser install state: the row may only offer an install
 * where one really exists. Drives the real store through the real events —
 * Chromium's beforeinstallprompt/appinstalled, an iOS Safari tab, a standalone
 * launch, and a browser with no path — never a hand-set state.
 */

let platformOs: 'android' | 'web' = 'web';

vi.mock('react-native', () => ({
    Platform: { get OS() { return platformOs; }, select: (options: Record<string, unknown>) => options.default },
}));

type Handler = (event: unknown) => void;

function fakeWindow(standalone: boolean) {
    const handlers = new Map<string, Handler>();
    return {
        handlers,
        addEventListener: (type: string, handler: Handler) => { handlers.set(type, handler); },
        matchMedia: (query: string) => ({ matches: standalone && query.includes('display-mode: standalone') }),
    };
}

const desktopChrome = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
};
const iosSafari = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5,
};

const reload = () => import('./webInstall');

afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
});

describe('web install state', () => {
    it('a native build never offers a browser install', async () => {
        platformOs = 'android';
        vi.stubGlobal('window', fakeWindow(false));
        vi.stubGlobal('navigator', desktopChrome);
        const mod = await reload();
        mod.startWebInstallCapture();
        expect(mod.getWebInstallState()).toBe('native');
    });

    it('a browser with no install path stays hidden', async () => {
        platformOs = 'web';
        const win = fakeWindow(false);
        vi.stubGlobal('window', win);
        vi.stubGlobal('navigator', desktopChrome);
        const mod = await reload();
        mod.startWebInstallCapture();
        expect(mod.getWebInstallState()).toBe('unavailable');
    });

    it('iOS Safari gets the Add to Home Screen guide', async () => {
        platformOs = 'web';
        vi.stubGlobal('window', fakeWindow(false));
        vi.stubGlobal('navigator', iosSafari);
        const mod = await reload();
        mod.startWebInstallCapture();
        expect(mod.getWebInstallState()).toBe('ios-guide');
    });

    it('a Chromium tab is ready once the prompt is held, installed after accepting', async () => {
        platformOs = 'web';
        const win = fakeWindow(false);
        vi.stubGlobal('window', win);
        vi.stubGlobal('navigator', desktopChrome);
        const mod = await reload();
        mod.startWebInstallCapture();
        expect(mod.getWebInstallState()).toBe('unavailable');

        const preventDefault = vi.fn();
        win.handlers.get('beforeinstallprompt')?.({
            preventDefault,
            prompt: vi.fn(async () => undefined),
            userChoice: Promise.resolve({ outcome: 'accepted' as const }),
        });
        expect(preventDefault).toHaveBeenCalled();
        expect(mod.getWebInstallState()).toBe('ready');

        await expect(mod.promptWebInstall()).resolves.toBe('accepted');
        expect(mod.getWebInstallState()).toBe('installed');
    });

    it('a standalone launch reads as installed without any event', async () => {
        platformOs = 'web';
        vi.stubGlobal('window', fakeWindow(true));
        vi.stubGlobal('navigator', iosSafari);
        const mod = await reload();
        mod.startWebInstallCapture();
        expect(mod.getWebInstallState()).toBe('installed');
    });

    it('the appinstalled event hides the row', async () => {
        platformOs = 'web';
        const win = fakeWindow(false);
        vi.stubGlobal('window', win);
        vi.stubGlobal('navigator', desktopChrome);
        const mod = await reload();
        mod.startWebInstallCapture();
        win.handlers.get('beforeinstallprompt')?.({ preventDefault: vi.fn(), prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'dismissed' as const }) });
        expect(mod.getWebInstallState()).toBe('ready');
        win.handlers.get('appinstalled')?.({});
        expect(mod.getWebInstallState()).toBe('installed');
    });
});
