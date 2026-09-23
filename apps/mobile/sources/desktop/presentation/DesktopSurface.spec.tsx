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
    hideKeyboard: () => undefined,
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
    const root = () => view.root as {
        findAllByProps(props: { accessibilityLabel?: string; accessibilityRole?: string }): unknown[];
        findByProps(props: { accessibilityLabel: string }): { props: { onPress(): void } };
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
    const notice = () => view.root.findByProps({ accessibilityLiveRegion: 'polite' }).children.join('');
    expect(notice()).toContain('Pinch to zoom');
    TestRenderer.act(() => vi.advanceTimersByTime(7000));
    expect(notice()).toBe('This computer cannot share its clipboard.');
    await TestRenderer.act(async () => view.unmount());

    available = true;
    const exit = vi.fn();
    await TestRenderer.act(async () => { view = TestRenderer.create(<DesktopSurface onExit={exit} />); });
    await TestRenderer.act(async () => root().findByProps({ accessibilityLabel: 'Clipboard' }).props.onPress());
    expect(root().findAllByProps({ accessibilityLabel: 'Copy to Phone' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Paste from Phone' })).toHaveLength(1);
    keyboardVisible = true;
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={exit} />));
    expect(root().findAllByProps({ accessibilityLabel: 'Back to the conversation' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Hide keyboard' })).toHaveLength(1);
    expect(view.root.findByType('DesktopView').props.keyboardClearance).toBe(96);
    expect(view.root.findByType('DesktopKeyRow')).toBeDefined();

    screenWidth = 594;
    screenHeight = 270;
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={exit} />));
    expect(root().findAllByProps({ accessibilityRole: 'header' })).toHaveLength(0);
    expect(root().findAllByProps({ accessibilityLabel: 'Back to the conversation' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Desktop actions' }).props.onPress());
    expect(root().findAllByProps({ accessibilityLabel: 'Gestures' })).toHaveLength(1);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Gestures' }).props.onPress());
    expect(root().findAllByProps({ accessibilityLabel: 'Tap: Click' })).toHaveLength(1);
    TestRenderer.act(() => root().findByProps({ accessibilityLabel: 'Back to the conversation' }).props.onPress());
    expect(exit).toHaveBeenCalledTimes(1);

    keyboardVisible = false;
    await TestRenderer.act(async () => view.update(<DesktopSurface onExit={exit} />));
    expect(root().findAllByProps({ accessibilityRole: 'header' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Desktop actions' })).toHaveLength(1);
    await TestRenderer.act(async () => view.unmount());
    vi.useRealTimers();
});
