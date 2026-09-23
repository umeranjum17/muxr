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
        useSharedValue: (initial: number) => ({ value: initial }),
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
    observeWebKeyboardMotion: () => () => undefined,
    useDesktopSession: (options: { authorize: () => Promise<unknown> }) => {
        authorize = options.authorize;
        return session;
    },
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/ui', () => ({ ui: { radius: { control: 8 } } }));
vi.mock('@/catalog', () => ({ sync: { request: async () => ({ clipboard: available }) } }));
vi.mock('@/catalog/store', () => ({ useLocalSettingMutable: () => [openedBefore, (value: boolean) => { openedBefore = value; }], useMachine: () => null }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: 'computer' }) }));
vi.mock('./DesktopKeyRow', () => ({ DesktopKeyRow: 'DesktopKeyRow', DESKTOP_KEY_ROW_HEIGHT: 36 }));

import { DesktopSurface } from './DesktopSurface';

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
        props: { onPress(): void; style: unknown; keyboardClearance: number };
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
    expect(notice()).toContain('Pinch to zoom');
    TestRenderer.act(() => { vi.advanceTimersByTime(7000); });
    expect(notice()).toBe('This computer cannot share its clipboard.');
    await TestRenderer.act(async () => view.unmount());

    session.hideKeyboard.mockClear();
    available = true;
    const exit = vi.fn();
    await TestRenderer.act(async () => { view = TestRenderer.create(<DesktopSurface onExit={exit} />); });
    // A hardware keyboard leaves the visual viewport unchanged, but its extra keys must be visible and clear the controls.
    await TestRenderer.act(async () => root().findByProps({ accessibilityLabel: 'Keyboard' }).props.onPress());
    const keyRow = root().findByType('DesktopKeyRow').parent;
    expect(style(keyRow.props.style).opacity).toBe(1);
    expect(style(root().findByProps({ accessibilityLabel: 'Hide keyboard' }).parent.props.style).transform[0].translateY).toBeLessThan(0);
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
    fits(['Tap: Click', 'Double-tap: Double-click', 'Hold: Right-click', 'Hold and drag: Select or drag', 'Two fingers: Scroll', 'Pinch: Zoom', 'Drag: Move around when zoomed'], true);
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
    fits(['Tap: Click', 'Double-tap: Double-click', 'Hold: Right-click', 'Hold and drag: Select or drag', 'Two fingers: Scroll', 'Pinch: Zoom', 'Drag: Move around when zoomed'], true);
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    await TestRenderer.act(async () => view.unmount());
    vi.useRealTimers();
});
