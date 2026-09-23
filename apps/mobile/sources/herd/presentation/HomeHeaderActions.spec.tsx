import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('react-native', () => ({
    View: 'View',
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
vi.mock('@/components/MobileGlass', () => ({
    MobileGlassSurface: ({ children, ...props }: any) => React.createElement('Glass', props, children),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { HomeHeaderActions } from './HomeHeaderActions';

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
        expect(flatten(renderer!.root.findAllByType('View')[0].props.style).gap).toBe(0);
        for (const button of buttons) {
            expect(flatten(button.props.style)).toMatchObject({ width: 44, height: 44 });
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
});
