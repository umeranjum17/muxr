import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { View } from 'react-native';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    View: 'View',
    Text: 'Text',
    Pressable: ({ children, ...props }: any) => {
        const [pressed, setPressed] = React.useState(false);
        return React.createElement('Pressable', {
            ...props,
            onPressIn: () => setPressed(true),
            onPressOut: () => setPressed(false),
        }, typeof children === 'function' ? children({ pressed }) : children);
    },
    useWindowDimensions: () => ({ width: 270, height: 594 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: () => unknown) => styles() },
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#fff' } } } }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/HeaderLogo', () => ({ HeaderLogo: () => null }));
vi.mock('@/components/StatusDot', () => ({ StatusDot: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/MobileGlass', () => ({
    MobileGlassSurface: ({ children, ...props }: any) => React.createElement('Glass', props, children),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { HomeHeaderActions, HomeHeaderMark, HomeHeaderStatus } from './HomeHeaderActions';
import { connectionStatusPresentation } from '@/pairing/presentation/homeConnectionStatus';

const flatten = (style: any): Record<string, any> => Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean));

describe('compact home header actions', () => {
    it('keeps 36pt glass inside three separate 44pt targets at 270pt and routes each action', () => {
        const search = vi.fn();
        let renderer: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(<HomeHeaderActions searchActive={false} onSearchPress={search} />);
        });
        const buttons = renderer!.root.findAllByType('Pressable');
        expect(buttons).toHaveLength(3);
        expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
            'Panes', 'tools.names.search', 'settings.title',
        ]);
        expect(flatten(renderer!.root.findAllByType('View')[0].props.style).gap).toBe(6);
        for (const button of buttons) {
            expect(flatten(button.props.style)).toMatchObject({ width: 44, height: 44, marginHorizontal: -4 });
            expect(flatten(button.findByType('Glass').props.style)).toMatchObject({ width: 36, height: 36 });
            expect(button.findByType('Glass').props.pointerEvents).toBe('none');
            expect(button.findByType('Glass').props.interactive).toBe(true);
            expect(button.findByType('Glass').props.pressed).toBe(false);
            TestRenderer.act(() => { button.props.onPressIn(); });
            expect(button.findByType('Glass').props.pressed).toBe(true);
            TestRenderer.act(() => { button.props.onPressOut(); });
            expect(button.findByType('Glass').props.pressed).toBe(false);
        }
        TestRenderer.act(() => {
            buttons[0].props.onPress();
            buttons[1].props.onPress();
            buttons[2].props.onPress();
        });
        expect(push.mock.calls).toEqual([['/panes'], ['/settings']]);
        expect(search).toHaveBeenCalledOnce();
    });

    it('fits connecting status before the 44pt actions at 270pt', () => {
        const connecting = connectionStatusPresentation(
            { status: 'connecting' },
            { colors: { status: { connecting: '#aaa' } } } as any,
        );
        let renderer: TestRenderer.ReactTestRenderer;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(<View>
                <HomeHeaderMark />
                <HomeHeaderStatus {...connecting} />
                <HomeHeaderActions searchActive={false} onSearchPress={() => {}} />
            </View>);
        });
        const root = renderer!.root;
        const markWidth = flatten(root.findAllByType('Glass')[0].props.style).width;
        const actions = root.findAllByType('Pressable');
        const actionRow = root.findAllByType('View').find((view) => flatten(view.props.style).gap === 6)!;
        const actionWidth = actions.reduce((width, action) => {
            const target = flatten(action.props.style);
            expect(target.width).toBe(44);
            return width + target.width + 2 * target.marginHorizontal;
        }, (actions.length - 1) * flatten(actionRow.props.style).gap);
        const status = root.findByType('Text');
        const statusBox = root.findAllByType('View').find((view) => flatten(view.props.style).maxWidth === '100%')!;
        expect(status.props.children).toBe('status.connecting');
        expect(status.props.numberOfLines).toBe(1);
        expect(status.props.ellipsizeMode).toBe('tail');
        expect(flatten(status.props.style).flexShrink).toBe(1);
        expect(flatten(statusBox.props.style).maxWidth).toBe('100%');
        const titleLeft = 12 + markWidth + 8;
        const actionsLeft = 270 - 12 - actionWidth;
        const titleRight = actionsLeft - 8;
        const firstHitLeft = actionsLeft + flatten(actions[0].props.style).marginHorizontal;
        expect(actionWidth).toBe(120);
        expect(titleRight - titleLeft).toBe(74);
        expect(titleRight).toBeLessThan(firstHitLeft);
    });
});
