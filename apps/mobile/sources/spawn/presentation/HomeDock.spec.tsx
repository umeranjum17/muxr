import React from 'react';
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const keyboardHandler = vi.hoisted(() => ({ current: null as null | {
    onStart: (event: { height: number }) => void;
    onEnd: (event: { height: number }) => void;
} }));
const scrollToEnd = vi.hoisted(() => vi.fn());
const theme = vi.hoisted(() => ({ colors: {
    glass: { border: '#333', backgroundStrong: '#222', backgroundSubtle: '#222' },
    text: '#fff', textSecondary: '#aaa', surface: '#000', surfaceHighest: '#222',
    surfacePressedOverlay: '#333', fab: { background: '#fff', icon: '#000' },
    status: { error: '#f00' },
} }));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Keyboard: { dismiss: vi.fn() },
    Modal: 'Modal',
    Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
    Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    useWindowDimensions: () => ({ width: 270, height: 594 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (make: (value: typeof theme) => unknown) => make(theme), hairlineWidth: 1 },
    useUnistyles: () => ({ theme }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: (handler: NonNullable<typeof keyboardHandler.current>) => { keyboardHandler.current = handler; },
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'Animated.View' }, Easing: { out: () => 0, in: () => 0, cubic: 0 },
    Extrapolation: { CLAMP: 'clamp' }, interpolate: () => 1, runOnJS: (fn: () => void) => fn,
    useAnimatedStyle: (style: () => unknown) => style(),
    useSharedValue: (value: number) => ({ value }), withTiming: (value: number) => value,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/MobileGlass', () => ({ MobileGlassSurface: 'MobileGlassSurface' }));
vi.mock('@/components/DictateButton', () => ({ DictateButton: () => null }));
vi.mock('@/components/OptionSheet', () => ({ OptionSheet: () => null }));
vi.mock('@/components/BubblePressable', () => ({ BubblePressable: 'BubblePressable' }));
vi.mock('@/settings', () => ({ NativeSettingsMenu: 'NativeSettingsMenu' }));
vi.mock('@/terminal/ui', () => ({ AgentInputAttachmentStrip: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 600 } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: null }) }));
vi.mock('../application/useNewSessionDraft', () => {
    const state = {
        agentType: 'pi', selectedMachineId: null, selectedPath: null, sessionType: 'simple', worktreeKey: null,
        setMachineId: vi.fn(), setAgentType: vi.fn(), setPath: vi.fn(), setSessionType: vi.fn(),
        setWorktreeKey: vi.fn(), setAttachments: vi.fn(),
    };
    return { useNewSessionDraft: Object.assign((select: (snapshot: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock('@/plugins/ui', () => ({ PluginSlot: () => null }));
vi.mock('@/conversation/ui', () => ({ RealtimeTalkButton: () => null }));
vi.mock('@/catalog/store', () => ({
    useAllMachines: () => [], useSessions: () => [], useSocketStatus: () => ({ status: 'disconnected' }),
}));
vi.mock('@/pairing', () => ({ isMachineOnline: () => false }));
vi.mock('@/utils/pathUtils', () => ({ resolveAbsolutePath: () => null }));
vi.mock('@/hooks/useImagePicker', () => ({ useImagePicker: () => ({
    selectedImages: [], pickImages: vi.fn(), removeImage: vi.fn(), clearImages: vi.fn(),
}) }));
vi.mock('@/catalog/sync', () => ({ sync: { request: vi.fn() } }));
vi.mock('@/catalog', () => ({ resolveAgentCatalog: vi.fn() }));
vi.mock('../application/homeDockEnvironment', () => ({
    applyWorktreeSelection: vi.fn(), currentDockAgent: () => ({ key: 'pi', name: 'Pi' }),
    listWorktreeOptions: () => Promise.resolve([]), projectDockOptions: () => [],
    resolveDockOption: () => null, selectedWorktreeKey: () => null,
    visibleDockAgents: () => [{ key: 'pi', name: 'Pi' }], worktreeDockOptions: () => [],
}));

import { HomeDock } from './HomeDock';

it('keeps the short-screen composer below Back and makes Start reachable by scrolling', () => {
    const previousFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
    try {
        let screen: any;
        TestRenderer.act(() => { screen = TestRenderer.create(
            <HomeDock prompt="" onPromptChange={vi.fn()} onSubmit={async () => true} onStartBlank={async () => true} isSubmitting={false} />,
            { createNodeMock: (node: any) => node.type === 'ScrollView' ? { scrollToEnd } : null },
        ); });
        const entry = screen.root.findAll((node: any) => node.props.onPress && node.props.style?.justifyContent === 'center')[0];
        TestRenderer.act(() => entry.props.onPress());
        const modalRoot = screen.root.findAll((node: any) => node.type === 'View' && node.props.onLayout)[0];
        TestRenderer.act(() => modalRoot.props.onLayout({ nativeEvent: { layout: { height: 594 } } }));
        TestRenderer.act(() => keyboardHandler.current?.onStart({ height: 290 }));
        TestRenderer.act(() => modalRoot.props.onLayout({ nativeEvent: { layout: { height: 304 } } }));
        const scroll = screen.root.findByType('ScrollView');
        expect(scroll.props.style.maxHeight).toBe(206);
        expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
        expect(scroll.findAll((node: any) => node.props.accessibilityLabel === 'Start Pi without a prompt')).toHaveLength(1);
        expect(scroll.findAllByType('TextInput')).toHaveLength(1);
        TestRenderer.act(() => scroll.props.onLayout());
        expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
        TestRenderer.act(() => keyboardHandler.current?.onStart({ height: 340 }));
        expect(screen.root.findByType('ScrollView').props.style.maxHeight).toBe(156);
        TestRenderer.act(() => keyboardHandler.current?.onEnd({ height: 0 }));
        expect(screen.root.findByType('ScrollView').props.style.maxHeight).toBe(496);
        TestRenderer.act(() => { screen.unmount(); });
    } finally {
        globalThis.requestAnimationFrame = previousFrame;
        scrollToEnd.mockClear();
    }
});
