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
        status: { error: '#f55' },
        button: { primary: { tint: '#000' } },
    },
};
// The terminal's own theme, which the whole control grid is meant to wear.
const terminalTheme = { colors: { ...theme.colors, text: '#ececec', textSecondary: '#9a9a9f' } };

// react-native-unistyles 3 in brief: ScopedTheme sets its theme only while its
// own children render, and useUnistyles keeps whatever was in force when the
// component mounted. A component mounted by a later, local re-render gets the
// phone's theme instead, which is how a light phone leaked into the grid.
const scope = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock('react-native', () => ({
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    Modal: 'Modal',
    Platform: { OS: 'android', select: (options: { android?: unknown; default?: unknown }) => options.android ?? options.default },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
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
vi.mock('react-native-unistyles', () => {
    const Apply = ({ name }: { name: string | undefined }) => { scope.current = name; return null; };
    return {
        ScopedTheme: ({ name, children }: { name: string; children: React.ReactNode }) => {
            const previous = scope.current;
            return <><Apply name={name} />{children}<Apply name={previous} /></>;
        },
        useUnistyles: () => {
            const [name] = React.useState(() => scope.current);
            return { theme: name === 'dark' ? terminalTheme : theme };
        },
    };
});
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
import { KeyForm, TerminalControlGrid } from './TerminalKeyRowEditor';
import { TerminalKeyRow } from './TerminalKeyRow';
import { ScopedTheme } from 'react-native-unistyles';
import { DEFAULT_ROW_IDS } from '../domain/keyRow';

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

describe('terminal key row', () => {
    it('shows custom labels even when their bytes match catalog arrows and Enter', () => {
        const sendText = vi.fn();
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(<TerminalKeyRow channel={{ sendText }} entries={[
                { label: 'Submit', send: '\r' }, { label: 'Back', send: '\u001b[D' }, 'enter', 'left',
            ]} />);
        });
        expect(drawn(renderer)).toContain('Submit');
        expect(drawn(renderer)).toContain('Back');
        expect(drawn(renderer)).not.toContain('⏎');
        expect(drawn(renderer)).not.toContain('←');
        for (const label of ['Submit', 'Back', 'Enter', 'Left arrow']) press(renderer, label);
        expect(sendText.mock.calls.map(([bytes]) => bytes)).toEqual(['\r', '\u001b[D', '\r', '\u001b[D']);
    });
});

describe('terminal controls on a light phone', () => {
    it('keeps the key form, and the list it returns to, in the terminal theme', () => {
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(
                <ScopedTheme name="dark">
                    <TerminalControlGrid visible category="keys" onCategoryChange={() => undefined} onClose={() => undefined}
                        entries={null} seed={[...DEFAULT_ROW_IDS]} onChange={() => undefined}
                        actions={null} actionSeed={[]} onActionsChange={() => undefined}
                        recentLinks={[]} onRecentLink={() => undefined} viewCommands={[]}
                        keyboardDisabled={false} onKeyboardDisabledChange={() => undefined} />
                </ScopedTheme>,
            );
        });

        // Opening a form re-renders the key list alone, after the terminal's
        // own render has finished.
        press(renderer, 'Edit esc');
        const nameField = renderer.root.findByProps({ accessibilityLabel: 'Key name' });
        expect(nameField.props.style[1].color).toBe(terminalTheme.colors.text);

        // Cancelling mounts the list again, preview row included.
        const cancel = renderer.root.findAllByType('Text').find((node: any) => node.props.children === 'Cancel');
        TestRenderer.act(() => { cancel.parent.props.onPress(); });
        const preview = renderer.root.find((node: any) => String(node.props['aria-label'] ?? '').startsWith('Key row preview'));
        const ctrl = preview.findAllByType('Text').find((node: any) => node.props.children === 'ctrl');
        expect(ctrl.props.style.color).toBe(terminalTheme.colors.textSecondary);
    });
});
