import React from 'react';
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { PREVIEW_DROP_MS, PreviewChip, PreviewTooltip, usePreviewGate } from './PreviewChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Pressable: 'Pressable', Text: 'Text', View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'Animated.View' },
    Easing: { out: (easing: () => number) => easing, cubic: () => (value: number) => value },
    useAnimatedStyle: (style: () => unknown) => style(),
    useReducedMotion: () => false,
    useSharedValue: (initial: number) => React.useRef({ value: initial }).current,
    withTiming: (value: number) => value,
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    text: '', textSecondary: '', divider: '', surfaceHighest: '', status: { connected: '' },
    terminalChrome: { cluster: '', clusterPressed: '' },
} } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/text', async () => {
    const { en } = await import('@/text/_default');
    const t = (key: string, params?: Record<string, unknown>): string => {
        const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
        return typeof value === 'function' ? (value as (input: unknown) => string)(params) : typeof value === 'string' ? value : key;
    };
    return { t };
});

type Presence = { kind: 'browser' | 'android'; title?: string; since: number };

let granted = true;
let live = true;
let preview: Presence | undefined;
const watched = vi.fn();

const Harness = () => {
    const gate = usePreviewGate('flow', preview, { showable: true, granted, live });
    return (<>
        <PreviewChip preview={gate.shown} live={gate.live} openable={gate.openable}
            labelled={gate.openable && gate.tooltip.open} onPress={watched} onLayout={() => undefined} />
        <PreviewTooltip preview={gate.openable && gate.tooltip.open ? gate.shown : undefined}
            anchor={{ centre: 100, top: 40 }} screenWidth={270} onWatch={watched} onDismiss={gate.tooltip.dismiss} />
    </>);
};

type PressedStyle = (state: { pressed: boolean }) => { opacity: number };

type Node = {
    props: { disabled?: boolean; style: unknown; onPress?: () => void };
    findAllByProps(props: Record<string, unknown>): Node[];
    findByProps(props: Record<string, unknown>): Node;
    findAllByType(type: string): Node[];
};

it('keeps a stale chip honest when the link drops, and takes it away when the drop outlasts the reconnect', async () => {
    vi.useFakeTimers();
    preview = { kind: 'browser', title: 'Pricing', since: 4_000 };
    let view!: ReturnType<typeof TestRenderer.create>;
    const update = async () => TestRenderer.act(async () => { view.update(<Harness />); });
    const root = () => view.root as unknown as Node;
    const chip = () => root().findByProps({ accessibilityLabel: 'Browser in use, Pricing. Watch live' });
    const watchButton = () => root().findAllByProps({ accessibilityLabel: 'Watch' });
    const dot = () => chip().findAllByType('View');
    const ink = () => (typeof chip().props.style === 'function' ? (chip().props.style as PressedStyle)({ pressed: false }) : chip().props.style as { opacity: number });

    await TestRenderer.act(async () => { view = TestRenderer.create(<Harness />); });

    // Live: the chip introduces itself once, and Watch opens the view.
    expect(chip().props.disabled).toBe(false);
    expect(dot()).toHaveLength(1);
    expect(watchButton()).toHaveLength(1);
    TestRenderer.act(() => { watchButton()[0]!.props.onPress!(); });
    expect(watched).toHaveBeenCalledTimes(1);

    // The link drops while the host still reports the window: the chip keeps
    // its place but dimmed, without the dot and deaf, and the tooltip goes
    // quiet instead of offering Watch against an unreachable host.
    live = false;
    await update();
    await TestRenderer.act(async () => { vi.advanceTimersByTime(300); });
    expect(chip().props.disabled).toBe(true);
    expect(dot()).toHaveLength(0);
    expect(ink().opacity).toBe(0.5);
    expect(watchButton()).toHaveLength(0);
    expect(watched).toHaveBeenCalledTimes(1);

    // A blip that recovers puts the chip back before the drop could take it.
    live = true;
    await update();
    await TestRenderer.act(async () => { vi.advanceTimersByTime(1_000); });
    expect(chip().props.disabled).toBe(false);
    expect(dot()).toHaveLength(1);

    // A drop that outlasts the reconnect takes the stale chip away.
    live = false;
    await update();
    await TestRenderer.act(async () => { vi.advanceTimersByTime(PREVIEW_DROP_MS); });
    await TestRenderer.act(async () => { vi.advanceTimersByTime(300); });
    expect(root().findAllByProps({ accessibilityLabel: 'Browser in use, Pricing. Watch live' })).toHaveLength(0);

    // The host vouching again brings the chip back.
    live = true;
    await update();
    expect(chip().props.disabled).toBe(false);
    expect(dot()).toHaveLength(1);

    // A view-only device sees presence, but no way in and no announcement.
    granted = false;
    preview = { kind: 'browser', title: 'Docs', since: 9_000 };
    await update();
    await TestRenderer.act(async () => { vi.advanceTimersByTime(300); });
    const quiet = () => root().findByProps({ accessibilityLabel: 'Browser in use, Docs. Watch live' });
    expect(quiet().props.disabled).toBe(true);
    expect(quiet().findAllByType('View')).toHaveLength(1);
    expect(root().findAllByProps({ accessibilityLabel: 'Watch' })).toHaveLength(0);
    await TestRenderer.act(async () => { view.unmount(); });
    vi.useRealTimers();
});
