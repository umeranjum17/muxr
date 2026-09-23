import React from 'react';
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let available = false;
let openedBefore = false;
let keyboardVisible = false;
let screenWidth = 270;
let screenHeight = 594;
let authorize: () => Promise<unknown>;
let reportKeyboardMotion: (motion: { covered: number; phase: number }) => void;
const session = {
    snapshot: { status: 'live', failure: null, diagnostics: {}, presented: true },
    nativeId: 'surface',
    connect: async () => { await authorize(); },
    close: async () => undefined,
    releaseHeld: () => undefined,
    hideKeyboard: vi.fn(() => undefined),
    showKeyboard: vi.fn(() => undefined),
    setOrientation: () => undefined,
    fitToView: () => undefined,
    copyRemoteToLocal: vi.fn(async (): Promise<{ text: string; truncated: boolean }> => ({ text: '', truncated: false })),
};

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', View: 'View', Pressable: 'Pressable',
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: screenWidth, height: keyboardVisible ? screenHeight - Math.min(290, screenHeight - 80) : screenHeight }),
    Dimensions: { get: () => ({ width: screenWidth, height: screenHeight }) },
}));
vi.mock('react-native-reanimated', () => {
    const fade = { delay: () => fade, duration: () => fade, reduceMotion: () => fade };
    return {
        default: { View: 'Animated.View' },
        FadeIn: fade,
        FadeOut: fade,
        ReduceMotion: { System: 'system' },
        useAnimatedStyle: (style: () => unknown) => style(),
        useSharedValue: (initial: number) => React.useRef({ value: initial }).current,
        withTiming: (value: number) => value,
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: () => ({ isVisible: keyboardVisible }),
    useReanimatedKeyboardAnimation: () => ({ height: { value: keyboardVisible ? -Math.min(290, screenHeight - 80) : 0 }, progress: { value: keyboardVisible ? 1 : 0 } }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    text: '', textSecondary: '', surfaceHighest: '', surfacePressed: '',
    glass: { border: '' }, terminalChrome: { cluster: '', clusterPressed: '' },
    button: { primary: { background: '', tint: '' } },
} } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon', MaterialCommunityIcons: 'Icon' }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => '', setStringAsync: async () => undefined }));
vi.mock('@desklink/react-native', () => ({
    DesktopView: 'DesktopView',
    observeWebKeyboardMotion: (subscriber: typeof reportKeyboardMotion) => {
        reportKeyboardMotion = subscriber;
        subscriber({ covered: 0, phase: 0 });
        return () => undefined;
    },
    useDesktopSession: (options: { authorize: () => Promise<unknown> }) => {
        authorize = options.authorize;
        return session;
    },
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/components/ui', () => ({ ui: { radius: { control: 8 } } }));
vi.mock('@/catalog', () => ({ sync: { request: async () => ({ clipboard: available }) } }));
vi.mock('@/catalog/store', () => ({ useLocalSettingMutable: () => [openedBefore, (value: boolean) => { openedBefore = value; }], useMachine: () => null }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: 'computer' }) }));
vi.mock('./DesktopKeyRow', () => ({ DesktopKeyRow: 'DesktopKeyRow', DESKTOP_KEY_ROW_HEIGHT: 36 }));

import { DesktopSurface } from './DesktopSurface';

it('starts web clipboard copy in the tap and waits for the write before reporting success', async () => {
    available = true;
    openedBefore = true;
    session.snapshot.status = 'live';
    let resolveRemote!: (value: { text: string; truncated: boolean }) => void;
    let resolveWrite!: () => void;
    const remote = new Promise<{ text: string; truncated: boolean }>((resolve) => { resolveRemote = resolve; });
    const webWrite = vi.fn((_items: FakeClipboardItem[]) => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    class FakeClipboardItem {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write: webWrite } });
    session.copyRemoteToLocal.mockImplementation(() => remote);
    let view!: ReturnType<typeof TestRenderer.create>;
    try {
        await TestRenderer.act(async () => { view = TestRenderer.create(<DesktopSurface onExit={() => undefined} />); });
        TestRenderer.act(() => view.root.findByProps({ accessibilityLabel: 'Clipboard' }).props.onPress());
        TestRenderer.act(() => view.root.findByProps({ accessibilityLabel: 'Copy to Phone' }).props.onPress());
        expect(webWrite).toHaveBeenCalledTimes(1);
        expect(view.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(0);
        await TestRenderer.act(async () => { resolveRemote({ text: 'remote text', truncated: false }); await Promise.resolve(); });
        expect(await webWrite.mock.calls[0][0][0].data['text/plain'].then((blob) => blob.text())).toBe('remote text');
        expect(view.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(0);
        await TestRenderer.act(async () => { resolveWrite(); });
        expect(view.root.findByProps({ accessibilityLiveRegion: 'polite' }).children.join('')).toBe('Copied to this phone.');
    } finally {
        await TestRenderer.act(async () => { if (view) view.unmount(); });
        vi.unstubAllGlobals();
    }
});

it('keeps a portrait desktop usable with the keyboard up and explains unavailable clipboard after the first hint', async () => {
    available = false;
    openedBefore = false;
    keyboardVisible = false;
    screenWidth = 270;
    screenHeight = 594;
    session.snapshot.status = 'starting';
    vi.useFakeTimers();
    let view!: ReturnType<typeof TestRenderer.create>;
    type Rendered = {
        props: { onPress(): void; style: unknown; keyboardClearance: number; pointerEvents?: string };
        children: (Rendered | string)[];
        parent: Rendered;
        findAllByProps(props: { accessibilityLabel?: string; accessibilityRole?: string }): Rendered[];
        findByProps(props: { accessibilityLabel?: string; accessibilityRole?: string; accessibilityLiveRegion?: string }): Rendered;
        findByType(type: string): Rendered;
        findAllByType(type: string): Rendered[];
    };
    const root = () => view.root as Rendered;
    const style = (value: unknown) => {
        const resolved = typeof value === 'function' ? value({ pressed: false }) : value;
        return Object.assign({}, ...(Array.isArray(resolved) ? resolved : [resolved])) as { top: number; minHeight: number; paddingVertical: number; lineHeight: number; opacity: number; transform: [{ translateY: number }] };
    };
    const fits = (labels: string[], help = false) => {
        const card = root().findByProps({ accessibilityLabel: labels[0] }).parent;
        const chrome = style(card.props.style);
        expect(card.children).toHaveLength(labels.length);
        const header = root().findByProps({ accessibilityRole: 'header' }).parent;
        const height = labels.reduce((sum, label) => {
            const row = root().findByProps({ accessibilityLabel: label });
            const dimensions = style(row.props.style);
            return sum + (help ? 2 * dimensions.paddingVertical + style((row.children[0] as Rendered).props.style).lineHeight : dimensions.minHeight);
        }, 0);
        const visibleHeight = keyboardVisible ? screenHeight - Math.min(290, screenHeight - 80) : screenHeight;
        expect(style(header.props.style).minHeight + chrome.top + 2 * chrome.paddingVertical + height + (help ? 18 : 0)).toBeLessThanOrEqual(visibleHeight);
    };
    await TestRenderer.act(async () => { view = TestRenderer.create(<DesktopSurface onExit={() => undefined} />); });
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Desktop actions' }).props.onPress());
    expect(root().findAllByProps({ accessibilityLabel: 'Gestures' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Disconnect' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Fit to screen' })).toHaveLength(0);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Desktop actions' }).props.onPress());
    session.snapshot.status = 'live';
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={() => undefined} />));
    expect(root().findAllByProps({ accessibilityLabel: 'Clipboard' })).toHaveLength(0);
    expect(root().findAllByProps({ accessibilityLabel: 'Copy to Phone' })).toHaveLength(0);
    expect(root().findAllByProps({ accessibilityLabel: 'Paste from Phone' })).toHaveLength(0);
    const notice = () => root().findByProps({ accessibilityLiveRegion: 'polite' }).children.join('');
    expect(notice()).toContain('Drag to move the pointer');
    TestRenderer.act(() => { vi.advanceTimersByTime(7000); });
    expect(notice()).toBe('This computer cannot share its clipboard.');
    await TestRenderer.act(async () => view.unmount());

    session.hideKeyboard.mockClear();
    available = true;
    const exit = vi.fn();
    await TestRenderer.act(async () => { view = TestRenderer.create(<DesktopSurface onExit={exit} />); });
    // Opening must not jump before a phone keyboard starts covering the viewport.
    await TestRenderer.act(async () => root().findByProps({ accessibilityLabel: 'Keyboard' }).props.onPress());
    const rowOpacity = () => style(root().findByType('DesktopKeyRow').parent.props.style).opacity;
    const controlsY = () => style(root().findByProps({ accessibilityLabel: 'Hide keyboard' }).parent.props.style).transform[0].translateY;
    expect(rowOpacity()).toBe(0);
    expect(root().findByType('DesktopKeyRow').parent.props.pointerEvents).toBe('none');
    expect(controlsY()).toBe(0);
    TestRenderer.act(() => { vi.advanceTimersByTime(90); reportKeyboardMotion({ covered: 30, phase: 0.25 }); });
    expect(rowOpacity()).toBe(0.25);
    expect(root().findByType('DesktopKeyRow').parent.props.pointerEvents).toBe('auto');
    TestRenderer.act(() => { vi.advanceTimersByTime(180); });
    expect(rowOpacity()).toBe(0.25);
    // A hardware keyboard leaves the viewport unchanged; after quiet, its keys become usable.
    TestRenderer.act(() => reportKeyboardMotion({ covered: 0, phase: 0 }));
    expect(rowOpacity()).toBe(0);
    TestRenderer.act(() => { vi.advanceTimersByTime(179); });
    expect(rowOpacity()).toBe(0);
    TestRenderer.act(() => { vi.advanceTimersByTime(1); });
    expect(rowOpacity()).toBe(1);
    expect(root().findByType('DesktopKeyRow').parent.props.pointerEvents).toBe('auto');
    expect(controlsY()).toBeLessThan(0);
    await TestRenderer.act(async () => root().findByProps({ accessibilityLabel: 'Hide keyboard' }).props.onPress());
    expect(root().findAllByType('DesktopKeyRow')).toHaveLength(0);
    session.hideKeyboard.mockClear();
    await TestRenderer.act(async () => root().findByProps({ accessibilityLabel: 'Clipboard' }).props.onPress());
    expect(root().findAllByProps({ accessibilityLabel: 'Copy to Phone' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Paste from Phone' })).toHaveLength(1);
    keyboardVisible = true;
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={exit} />));
    expect(root().findAllByProps({ accessibilityLabel: 'Back to the conversation' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Hide keyboard' })).toHaveLength(1);
    expect(root().findByType('DesktopView').props.keyboardClearance).toBe(96);
    expect(root().findByType('DesktopKeyRow')).toBeDefined();
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Desktop gestures' }).props.onPress());
    expect(session.hideKeyboard).toHaveBeenCalledTimes(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Tap: Click' })).toHaveLength(0);
    keyboardVisible = false;
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={exit} />));
    fits(['Tap: Click', 'Double-tap: Double-click', 'Hold: Right-click', 'Hold and drag: Select or drag', 'Two fingers: Scroll', 'Pinch: Zoom', 'Drag: Move around when zoomed', 'Drag on the whole desktop: Move the pointer'], true);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Desktop gestures' }).props.onPress());

    keyboardVisible = true;
    screenWidth = 594;
    screenHeight = 270;
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={exit} />));
    expect(root().findAllByProps({ accessibilityRole: 'header' })).toHaveLength(0);
    expect(root().findAllByProps({ accessibilityLabel: 'Back to the conversation' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Back to the conversation' }).props.onPress());
    expect(exit).toHaveBeenCalledTimes(1);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Desktop actions' }).props.onPress());
    expect(session.hideKeyboard).toHaveBeenCalledTimes(2);
    expect(root().findAllByProps({ accessibilityLabel: 'Gestures' })).toHaveLength(0);
    keyboardVisible = false;
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={exit} />));
    expect(root().findAllByProps({ accessibilityRole: 'header' })).toHaveLength(1);
    fits(['Gestures', 'Fit to screen', 'Disconnect']);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Gestures' }).props.onPress());
    fits(['Tap: Click', 'Double-tap: Double-click', 'Hold: Right-click', 'Hold and drag: Select or drag', 'Two fingers: Scroll', 'Pinch: Zoom', 'Drag: Move around when zoomed', 'Drag on the whole desktop: Move the pointer'], true);
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    await TestRenderer.act(async () => view.unmount());
    vi.useRealTimers();
});
