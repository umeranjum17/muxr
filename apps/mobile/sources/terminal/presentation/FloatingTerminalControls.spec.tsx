import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * The floating control's two modes are exclusive: the ring and the arrow
 * cluster are never on screen together, and a press that was only held (never
 * moved) must not turn the next press-and-slide into a drag. Both were review
 * findings against the real component, so this drives its own handlers rather
 * than trusting the reading of them.
 */

const theme = {
    colors: {
        text: '#ffffff',
        textSecondary: '#999999',
        surfaceHighest: '#222222',
        accent: '#00aaff',
        glass: { border: '#333333', highlight: '#444444' },
        terminalChrome: { resting: '#111111', floating: '#222222', scrim: '#000000', cluster: '#303030', clusterPressed: '#484845' },
        status: { working: '#00aa00' },
    },
};

vi.mock('react-native', () => ({
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    // The responder callbacks, by the names the component hands them over.
    PanResponder: { create: (config: Record<string, unknown>) => ({ panHandlers: config }) },
    Pressable: 'Pressable',
    StyleSheet: { absoluteFill: {}, hairlineWidth: 1, create: (styles: Record<string, unknown>) => styles },
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'Animated.View', Text: 'Animated.Text' },
    Easing: { bezier: () => () => 0 },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    interpolateColor: () => '#000000',
    useAnimatedStyle: (style: () => unknown) => style(),
    useReducedMotion: () => false,
    useSharedValue: (initial: unknown) => ({ value: initial }),
    withTiming: (value: unknown) => value,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@/catalog/store', () => ({ useLocalSettingMutable: () => [null, () => undefined] }));
vi.mock('@/components/haptics', () => ({ hapticsLight: () => undefined, hapticsSelection: () => undefined }));

// eslint-disable-next-line
import { FloatingTerminalControls, type ClusterKey, type RingSlot } from './FloatingTerminalControls';

const arrows: RingSlot = { id: 'arrows', label: 'Arrows', icon: 'code', opens: 'cluster', run: vi.fn() };
const other: RingSlot = { id: 'other', label: 'Other', icon: 'code', run: vi.fn() };
const keys: ClusterKey[] = [
    { id: 'up', label: 'Up arrow', icon: 'arrow-up', at: 'up', run: vi.fn() },
    { id: 'down', label: 'Down arrow', icon: 'arrow-down', at: 'down', run: vi.fn() },
];

function mount(terminalHeight = 620) {
    let renderer: any;
    TestRenderer.act(() => {
        renderer = TestRenderer.create(
            <FloatingTerminalControls
                width={360}
                height={740}
                terminalHeight={terminalHeight}
                slots={[arrows, other]}
                clusterKeys={keys}
                dim={{ value: 0 } as never}
            />,
        );
    });
    return renderer!;
}

/** Re-renders at a new terminal height, the same as a keyboard or a wrapping
 *  draft resizing the surface under the control. */
const resize = (renderer: any, terminalHeight: number) => TestRenderer.act(() => {
    renderer.update(
        <FloatingTerminalControls
            width={360}
            height={740}
            terminalHeight={terminalHeight}
            slots={[arrows, other]}
            clusterKeys={keys}
            dim={{ value: 0 } as never}
        />,
    );
});

const control = (renderer: any) => renderer.root.findAll((node: any) =>
    node.props.accessibilityLabel === 'Terminal quick actions' || node.props.accessibilityLabel === 'Close terminal quick actions')[0];
const slot = (renderer: any, label: string) => renderer.root.findAll((node: any) => node.props.accessibilityLabel === label)[0];
const pan = (renderer: any) => renderer.root.findAll((node: any) => typeof node.props.onPanResponderGrant === 'function')[0];
/** The control's own box, which is what has to stay inside the terminal. */
const puckBox = (renderer: any): { top: number; height: number } => {
    const node = renderer.root.findAll((node: any) => Array.isArray(node.props.style)
        && node.props.style[0]?.position === 'absolute' && node.props.style[0]?.height === 44)[0];
    return { top: node.props.style[0].top, height: node.props.style[0].height };
};
const clusterShown = (renderer: any) => renderer.root.findAll((node: any) => node.props.accessibilityLabel === 'Up arrow').length > 0;
// The slots draw at rest and register touches only with the ring up; the
// cluster's own keys are the other overlay.
const ringUp = (renderer: any) => slot(renderer, 'Other').props.disabled === false;

const tap = (renderer: any, node: any) => TestRenderer.act(() => { node.props.onPress(); });
const grant = (renderer: any, dx: number, dy: number) => TestRenderer.act(() => {
    const event = { nativeEvent: { locationX: 22, locationY: 22 } };
    const state = { dx, dy };
    pan(renderer).props.onMoveShouldSetPanResponderCapture(event, state);
    pan(renderer).props.onPanResponderGrant(event, state);
});

describe('floating terminal control', () => {
    it('puts one overlay up at a time, and the cluster dismisses through its own layer', () => {
        const renderer = mount();
        expect(clusterShown(renderer)).toBe(false);
        expect(ringUp(renderer)).toBe(false);
        expect(control(renderer)).toBeDefined();

        tap(renderer, control(renderer));
        expect(ringUp(renderer)).toBe(true);
        expect(clusterShown(renderer)).toBe(false);

        tap(renderer, slot(renderer, 'Arrows'));
        expect(clusterShown(renderer)).toBe(true);
        expect(ringUp(renderer)).toBe(false);
        // The control stands down while the cluster owns the surface, so it can
        // never be pressed through the open cluster.
        expect(control(renderer)).toBeUndefined();

        // The cluster's own layer dismisses it and brings the control back.
        const dismiss = renderer.root.findAll((node: any) => node.props.accessibilityLabel === 'Close arrow keys')[0];
        tap(renderer, dismiss);
        expect(clusterShown(renderer)).toBe(false);
        expect(control(renderer)).toBeDefined();
    });

    it('comes back as the open control when a resize takes the cluster below its floor', () => {
        const renderer = mount();
        tap(renderer, control(renderer));
        tap(renderer, slot(renderer, 'Arrows'));
        expect(clusterShown(renderer)).toBe(true);

        // 45dp cannot hold a 38dp key plus the pad at both ends, so the cluster
        // is declined: the control returns as the open control, not latched in
        // the cluster mode it can no longer render.
        resize(renderer, 45);
        expect(clusterShown(renderer)).toBe(false);
        expect(control(renderer)).toBeDefined();
        // And it stays inside the terminal it belongs to. This view does not
        // clip, so a control hanging past the bottom edge sits over the key row
        // and takes touches meant for those keys.
        const box = puckBox(renderer);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.top + box.height).toBeLessThanOrEqual(45);
        expect(control(renderer).props.accessibilityLabel).toBe('Terminal quick actions');
        expect(control(renderer).props.accessibilityState).toEqual({ expanded: false });

        // Growing back must not re-arm the mode that was declined while it
        // could not be drawn: no press happens between the two sizes.
        resize(renderer, 620);
        expect(clusterShown(renderer)).toBe(false);
        expect(control(renderer)).toBeDefined();
        expect(control(renderer).props.accessibilityLabel).toBe('Terminal quick actions');

        // And the tap opens the ring rather than only clearing stale state.
        tap(renderer, control(renderer));
        expect(ringUp(renderer)).toBe(true);
    });

    it('keeps a pickup for a captured drag but clears a still hold', () => {
        const renderer = mount();
        TestRenderer.act(() => { control(renderer).props.onLongPress(); });
        TestRenderer.act(() => { control(renderer).props.onPressOut(); });
        grant(renderer, 12, 0);
        expect(ringUp(renderer)).toBe(true);

        const dragged = mount();
        TestRenderer.act(() => { control(dragged).props.onLongPress(); });
        const responder = pan(dragged);
        TestRenderer.act(() => {
            responder.props.onMoveShouldSetPanResponderCapture({}, { dx: 12, dy: 0 });
            control(dragged).props.onPressOut();
            responder.props.onPanResponderGrant({ nativeEvent: { locationX: 22, locationY: 22 } }, { dx: 12, dy: 0 });
        });
        expect(ringUp(dragged)).toBe(false);
    });
});
