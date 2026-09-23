import React from 'react';
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let available = false;
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
    useWindowDimensions: () => ({ height: 600 }),
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
    useKeyboardState: () => ({ isVisible: false }),
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
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
    useDesktopSession: (options: { authorize: () => Promise<unknown> }) => {
        authorize = options.authorize;
        return session;
    },
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/ui', () => ({ ui: { radius: { control: 8 } } }));
vi.mock('@/catalog', () => ({ sync: { request: async () => ({ clipboard: available }) } }));
vi.mock('@/catalog/store', () => ({ useLocalSettingMutable: () => [true, () => undefined], useMachine: () => null }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: 'computer' }) }));
vi.mock('./DesktopKeyRow', () => ({ DesktopKeyRow: 'DesktopKeyRow', DESKTOP_KEY_ROW_HEIGHT: 36 }));

import { DesktopSurface } from './DesktopSurface';

it('hides both clipboard actions unless the captured desktop supports them', async () => {
    available = false;
    let view!: ReturnType<typeof TestRenderer.create>;
    const root = () => view.root as {
        findAllByProps(props: { accessibilityLabel: string }): unknown[];
        findByProps(props: { accessibilityLabel: string }): { props: { onPress(): void } };
    };
    await TestRenderer.act(async () => { view = TestRenderer.create(<DesktopSurface onExit={() => undefined} />); });
    expect(root().findAllByProps({ accessibilityLabel: 'Clipboard' })).toHaveLength(0);
    expect(root().findAllByProps({ accessibilityLabel: 'Copy to Phone' })).toHaveLength(0);
    expect(root().findAllByProps({ accessibilityLabel: 'Paste from Phone' })).toHaveLength(0);
    await TestRenderer.act(async () => view.unmount());

    available = true;
    await TestRenderer.act(async () => { view = TestRenderer.create(<DesktopSurface onExit={() => undefined} />); });
    await TestRenderer.act(async () => root().findByProps({ accessibilityLabel: 'Clipboard' }).props.onPress());
    expect(root().findAllByProps({ accessibilityLabel: 'Copy to Phone' })).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Paste from Phone' })).toHaveLength(1);
    await TestRenderer.act(async () => view.unmount());
});
