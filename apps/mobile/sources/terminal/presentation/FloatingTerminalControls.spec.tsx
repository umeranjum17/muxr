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

const sharedValues = vi.hoisted(() => [] as { value: number }[]);

const theme = {
    colors: {
        text: '#ffffff',
        textSecondary: '#999999',
        surfaceHighest: '#222222',
        accent: '#00aaff',
        glass: { border: '#333333', highlight: '#444444' },
        terminalChrome: { chrome: '#111111', resting: '#111111', floating: '#222222', scrim: '#000000', cluster: '#303030', clusterPressed: '#484845' },
        status: { working: '#00aa00' },
    },
};

vi.mock('react-native', () => ({
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    // The responder callbacks, by the names the component hands them over.
    PanResponder: { create: (config: Record<string, unknown>) => ({ panHandlers: config }) },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
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
    useSharedValue: (initial: number) => {
        const shared = { value: initial };
        sharedValues.push(shared);
        return shared;
    },
    withTiming: (value: unknown) => value,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@/components/ui', () => ({ withAlpha: (color: string) => color }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@/catalog/store', () => ({ useLocalSetting: () => null, useLocalSettingMutable: () => [null, () => undefined] }));
vi.mock('@/constants/Typography', () => ({ Typography: { mono: () => ({}) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: () => undefined, hapticsSelection: () => undefined }));

// eslint-disable-next-line
import { FloatingTerminalControls, TerminalMenuQuickActions, floatingControlFits, type ClusterKey, type RingSlot } from './FloatingTerminalControls';
import { TerminalKeyRow } from './TerminalKeyRow';
import { ringFan } from '../domain/ringGeometry';

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
const slot = (renderer: any, label: string) => renderer.root.findAll((node: any) => node.props?.accessibilityLabel === label)[0];
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

    it('sweeps into the arrow cluster after a short terminal grows', () => {
        vi.mocked(arrows.run).mockClear();
        const renderer = mount(45);
        resize(renderer, 86);
        const responder = pan(renderer);
        const box = responder.props.style[0];
        const target = ringFan({ x: box.left + 22, y: box.top + 22 }, { width: 360, height: 740 }, 86, 2, 48).offsets[0]!;
        TestRenderer.act(() => {
            responder.props.onMoveShouldSetPanResponderCapture({}, { dx: 12, dy: 0 });
            responder.props.onPanResponderGrant({ nativeEvent: { locationX: 22, locationY: 22 } }, { dx: 12, dy: 0 });
            responder.props.onPanResponderMove({}, { dx: 12 + target.x, dy: target.y });
            responder.props.onPanResponderRelease({}, { dx: 12 + target.x, dy: target.y });
        });
        expect(clusterShown(renderer)).toBe(true);
        expect(arrows.run).not.toHaveBeenCalled();
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

    it('rides the keyboard with the rails and lands where the shorter terminal puts it', () => {
        const shift = { value: 0 };
        const render = (terminalHeight: number) => (
            <FloatingTerminalControls width={360} height={740} terminalHeight={terminalHeight} slots={[arrows, other]} dim={{ value: 0 } as never} shift={shift as never} />
        );
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(render(620)); });
        const puck = () => renderer.root.findAll((node: any) => Array.isArray(node.props.style) && node.props.style[0]?.height === 44)[0];
        const shown = () => puck().props.style[0].top + puck().props.style[1].transform[1].translateY;
        const resting = shown();

        // The keyboard has lifted the rails 300dp; the terminal is not yet re-measured.
        shift.value = -300;
        TestRenderer.act(() => { renderer.update(render(620)); });
        expect(shown()).toBe(resting - 300);

        // It settles: the terminal is measured 300dp shorter and the shift is spent.
        shift.value = 0;
        TestRenderer.act(() => { renderer.update(render(320)); });
        expect(shown()).toBe(resting - 300);
        expect(shown() + 44).toBeLessThanOrEqual(320);
    });

    it('keeps a drag inside a 45dp terminal and routes compact actions through the pane menu', () => {
        const dragged = mount(45);
        const box = puckBox(dragged);
        const dragY = sharedValues[sharedValues.length - 1]!;
        TestRenderer.act(() => { control(dragged).props.onLongPress(); });
        const responder = pan(dragged);
        TestRenderer.act(() => {
            responder.props.onMoveShouldSetPanResponderCapture({}, { dx: 0, dy: 12 });
            control(dragged).props.onPressOut();
            responder.props.onPanResponderGrant({ nativeEvent: { locationX: 22, locationY: 22 } }, { dx: 0, dy: 12 });
            responder.props.onPanResponderMove({}, { dx: 0, dy: 200 });
        });
        expect(box.top + dragY.value + box.height).toBeLessThanOrEqual(45);

        const run = Array.from({ length: 6 }, () => vi.fn());
        const actions: RingSlot[] = ['Continue', 'Review changes', 'Arrow keys', 'Commands', 'Paste', 'Browser'].map((label, index) => ({
            id: ['continue', 'changes', 'arrows', 'commands', 'paste', 'browser'][index]!, label, icon: 'code', run: run[index]!,
        }));
        const sendText = vi.fn();
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(<>
                <FloatingTerminalControls width={270} height={594} terminalHeight={43} slots={actions} dim={{ value: 0 } as never} />
                <TerminalMenuQuickActions slots={actions} terminalHeight={43} hasTools onClose={() => undefined} />
                <TerminalKeyRow channel={{ sendText }} />
            </>);
        });
        expect(slot(renderer, 'Arrow keys')).toBeUndefined();
        for (const action of actions.filter((entry) => entry.id !== 'arrows')) tap(renderer, slot(renderer, action.label));
        for (const [label, bytes] of [['Left arrow', '\u001b[D'], ['Up arrow', '\u001b[A'], ['Down arrow', '\u001b[B'], ['Right arrow', '\u001b[C']]) {
            tap(renderer, slot(renderer, label));
            expect(sendText).toHaveBeenLastCalledWith(bytes);
        }
        expect(run[2]).not.toHaveBeenCalled();
        for (const invoked of run.filter((_, index) => index !== 2)) expect(invoked).toHaveBeenCalledOnce();
        expect(floatingControlFits(45)).toBe(true);
        TestRenderer.act(() => {
            renderer.update(<TerminalMenuQuickActions slots={actions} terminalHeight={45} hasTools onClose={() => undefined} />);
        });
        expect(renderer.root.findAll((node: any) => node.props?.accessibilityLabel === 'Browser')).toHaveLength(0);
        TestRenderer.act(() => {
            renderer.update(<TerminalMenuQuickActions slots={[actions[1]!, actions[5]!]} terminalHeight={45} hasTools={false} onClose={() => undefined} />);
        });
        tap(renderer, slot(renderer, 'Review changes'));
        tap(renderer, slot(renderer, 'Browser'));
        expect(run[1]).toHaveBeenCalledTimes(2);
        expect(run[5]).toHaveBeenCalledTimes(2);
    });
});
