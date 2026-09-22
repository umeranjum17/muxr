import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * The key form is where a person picks a key. This drives its real picker and
 * its real save rule, because two review findings lived exactly here: choosing
 * an action key (paste / hide kb) used to replace the whole picker with the
 * explanatory note — leaving Cancel as the only exit — and saving one used to
 * store a hand-rolled `{ label, send: '' }` entry that the stored schema
 * rejects, which took the device's entire customised row down with it.
 */

const theme = {
    colors: {
        text: '#fff',
        textSecondary: '#999',
        surfaceHigh: '#222',
        accent: '#0af',
        divider: '#333',
        warningCritical: '#f55',
        button: { primary: { tint: '#000' } },
    },
};

vi.mock('react-native', () => ({
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    Modal: 'Modal',
    Platform: { OS: 'android', select: (options: { android?: unknown; default?: unknown }) => options.android ?? options.default },
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
    useWindowDimensions: () => ({ width: 360, height: 792 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-gesture-handler', () => {
    const chain: Record<string, () => unknown> = {};
    chain.activateAfterLongPress = () => chain;
    chain.runOnJS = () => chain;
    chain.onStart = () => chain;
    chain.onUpdate = () => chain;
    chain.onEnd = () => chain;
    chain.onFinalize = () => chain;
    return {
        Gesture: { Pan: () => chain },
        GestureDetector: 'GestureDetector',
        GestureHandlerRootView: 'GestureHandlerRootView',
        ScrollView: 'ScrollView',
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { mono: () => ({}) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: () => undefined, hapticsSelection: () => undefined }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui', () => ({ ui: { radius: { control: 8 } } }));
vi.mock('@/catalog/store', () => ({
    useLocalSetting: () => [null],
    useLocalSettingMutable: () => [false, () => undefined],
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));

// eslint-disable-next-line
import { KeyForm } from './TerminalKeyRowEditor';

function mount(onSave: (entry: unknown) => void) {
    let renderer: any;
    TestRenderer.act(() => {
        renderer = TestRenderer.create(<KeyForm entry={undefined} onSave={onSave} onCancel={() => undefined} />);
    });
    return renderer!;
}

const press = (renderer: any, label: string) => {
    TestRenderer.act(() => { renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(); });
};
const present = (renderer: any, label: string) => renderer.root.findAllByProps({ accessibilityLabel: label }).length;
const drawn = (renderer: any): string => renderer.root.findAllByType('Text')
    .map((node: any) => (typeof node.props.children === 'string' ? node.props.children : ''))
    .join(' ');

describe('terminal key form with an action key', () => {
    it('keeps the picker while an action key is selected, and saves that catalog key', () => {
        const saved: unknown[] = [];
        const renderer = mount((entry) => saved.push(entry));

        press(renderer, 'Choose Paste into prompt');

        // The note appears alongside the picker, never instead of it: every key
        // is still there to be chosen without cancelling the form.
        expect(drawn(renderer)).toContain('Inserts the clipboard into the prompt');
        expect(present(renderer, 'Choose Escape')).toBe(1);
        expect(present(renderer, 'Choose Tab')).toBe(1);
        // Only what cannot apply to a key with no bytes is gone.
        expect(present(renderer, 'Key name')).toBe(0);
        expect(present(renderer, 'Repeat while held')).toBe(0);
        expect(present(renderer, 'Control modifier')).toBe(0);

        // Saving stores the catalog id itself. A hand-rolled entry with empty
        // bytes is what the stored schema refuses.
        press(renderer, 'Save key');
        expect(saved).toEqual(['paste']);

        // And the selection changes in place: no cancel, no re-entering the form.
        press(renderer, 'Choose Escape');
        expect(present(renderer, 'Control modifier')).toBe(1);
        expect(present(renderer, 'Letter or character')).toBe(1);
        expect(present(renderer, 'Key name')).toBe(1);
        expect(present(renderer, 'Repeat while held')).toBe(1);
        expect(drawn(renderer)).not.toContain('Inserts the clipboard into the prompt');

        press(renderer, 'Save key');
        expect(saved).toEqual(['paste', 'esc']);
    });

    it('lets an action key be saved even after an overlong name was typed into the hidden field', () => {
        const saved: unknown[] = [];
        const renderer = mount((entry) => saved.push(entry));

        // The name field is there for a byte key, and a name over the limit is
        // refused while the person can see the field they typed it in.
        TestRenderer.act(() => { renderer.root.findByProps({ accessibilityLabel: 'Key name' }).props.onChangeText('fourteenchars!'); });
        expect(present(renderer, 'Save key')).toBe(1);
        expect(renderer.root.findByProps({ accessibilityLabel: 'Save key' }).props.disabled).toBe(true);
        expect(drawn(renderer)).toContain('Keep the name to 12 characters.');

        // Choosing the action key hides that field, so it cannot keep Save
        // disabled: what is hidden cannot block the choice.
        press(renderer, 'Choose Paste into prompt');
        expect(present(renderer, 'Key name')).toBe(0);
        expect(drawn(renderer)).not.toContain('Keep the name to 12 characters.');
        expect(renderer.root.findByProps({ accessibilityLabel: 'Save key' }).props.disabled).toBe(false);
        press(renderer, 'Save key');
        expect(saved).toEqual(['paste']);

        // Switching back to a byte key shows the field again, still over the
        // limit, so the rule was never dropped for a visible field.
        press(renderer, 'Choose Escape');
        expect(present(renderer, 'Key name')).toBe(1);
        expect(renderer.root.findByProps({ accessibilityLabel: 'Save key' }).props.disabled).toBe(true);
        expect(drawn(renderer)).toContain('Keep the name to 12 characters.');
    });
});
