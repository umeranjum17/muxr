import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => {
    // Views are class instances so row-wrapper refs are capturable and each can
    // spy on scrollIntoView, the web DOM API the scroll effect drives.
    class View extends React.Component<{ children?: React.ReactNode }> {
        scrollIntoView: () => void;
        constructor(props: { children?: React.ReactNode }) {
            super(props);
            this.scrollIntoView = vi.fn();
        }
        render() { return this.props.children ?? null; }
    }
    class ScrollView extends React.Component<{ children?: React.ReactNode }> {
        render() { return this.props.children ?? null; }
    }
    return {
        Platform: { OS: 'web', select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default },
        View,
        ScrollView,
        Text: 'Text',
        Pressable: 'Pressable',
        StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
    };
});
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    useUnistyles: () => ({ theme: { colors: {} } }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// The hook resolves its quiet line through the catalogue; these rows are not
// about wording, and the real module would drag Expo's native runtime in.
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/catalog/store', () => ({ useLocalSetting: () => 'seamless' }));
vi.mock('@/components/ui', () => ({ SectionLabel: 'Text', withAlpha: (color: string) => color }));

// eslint-disable-next-line
import { View as MockView } from 'react-native';
import { CommandPaletteItem } from './CommandPaletteItem';
import { CommandPaletteResults } from './CommandPaletteResults';
import { useCommandPalette } from './useCommandPalette';
import { CUSTOM_CATEGORY } from './types';
import type { Command, CommandCategory } from './types';

const compact: Command = {
    id: '/compact', title: '/compact', hint: '[focus]', subtitle: 'Compact context.',
    category: 'All commands', action: () => undefined, secondaryAction: () => undefined,
};

describe('terminal command palette rows', () => {
    it('draws the tap target and the pencil as sibling buttons that both work, never button-in-button', () => {
        const onPress = vi.fn();
        const onSecondaryPress = vi.fn();
        const onHover = vi.fn();
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(
                <CommandPaletteItem command={compact} isSelected={false} appearance="terminal"
                    onPress={onPress} onSecondaryPress={onSecondaryPress} onHover={onHover} />,
            );
        });
        const root = renderer!.root;

        // The web DOM rule the palette must satisfy: no button inside a button.
        // findAllByType counts a node itself, so nesting shows up as a pressable
        // seeing more than one button in its subtree.
        const pressables: any[] = root.findAllByType('Pressable');
        expect(pressables.length).toBeGreaterThanOrEqual(2);
        expect(pressables.filter((node) => node.findAllByType('Pressable').length > 1)).toHaveLength(0);

        const row = root.findByProps({ accessibilityLabel: '/compact, Compact context.. Sends now.' });
        expect(row.props.accessibilityRole).toBe('button');
        TestRenderer.act(() => { row.props.onPress(); });
        expect(onPress).toHaveBeenCalledTimes(1);

        const pencil = root.findByProps({ accessibilityLabel: 'Edit /compact' });
        expect(pencil.props.accessibilityRole).toBe('button');
        TestRenderer.act(() => { pencil.props.onPress(); });
        expect(onSecondaryPress).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(1);

        // Hovering either target moves the keyboard selection, as before.
        TestRenderer.act(() => { row.props.onHoverIn(); });
        TestRenderer.act(() => { pencil.props.onHoverIn(); });
        expect(onHover).toHaveBeenCalledTimes(2);
    });

    it('draws every Custom row a non-matching query keeps visible, with no duplicate section key', () => {
        const custom = (id: string, title: string): Command => ({ id, title, category: CUSTOM_CATEGORY, action: () => undefined });
        const commands = [custom('custom-command', 'Run a custom command'), custom('edit-quick-actions', 'Edit replies and commands')];
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        // The real hook drives the real rows: type a query nothing matches and
        // read what the palette actually paints.
        function Probe({ query }: { query: string }) {
            const palette = useCommandPalette(commands, () => undefined);
            React.useEffect(() => { palette.handleSearchChange(query); }, [query]);
            return <CommandPaletteResults categories={palette.categories} selectedIndex={0}
                onSelectCommand={() => undefined} onSelectionChange={() => undefined} appearance="terminal" quietLine={palette.quiet} />;
        }
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(<Probe query="zzqq" />); });
        const keyWarnings = consoleError.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('same key'));
        consoleError.mockRestore();

        // Sections are keyed by category id: one per Custom row must stay unique.
        expect(keyWarnings).toEqual([]);
        const rendered = renderer!.root.findAllByType(CommandPaletteItem);
        expect(rendered.map((node: any) => node.props.command.id)).toEqual(['custom-command', 'edit-quick-actions']);
    });

    it('opens without scrolling and only aligns a row once the selection moves to it', () => {
        const categories: CommandCategory[] = [{
            id: 'common', title: 'Common', commands: [
                { id: '/session', title: '/session', subtitle: 'Session stats.', category: 'Common', action: () => undefined },
                compact,
            ],
        }];
        const props = {
            categories, appearance: 'terminal' as const,
            onSelectCommand: vi.fn(), onSecondaryCommand: vi.fn(), onSelectionChange: vi.fn(),
        };
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(<CommandPaletteResults {...props} selectedIndex={0} />);
        });

        // Mount draws the sheet from the top: no scrollIntoView may fire while
        // the open animation runs, or the first section header scrolls away.
        const scrollCalls = () => renderer!.root.findAllByType(MockView)
            .reduce((total: number, node: any) => total + node.instance.scrollIntoView.mock.calls.length, 0);
        expect(scrollCalls()).toBe(0);

        TestRenderer.act(() => {
            renderer!.update(<CommandPaletteResults {...props} selectedIndex={1} />);
        });
        const called: any[] = renderer!.root.findAllByType(MockView)
            .filter((node: any) => node.instance.scrollIntoView.mock.calls.length > 0);
        // Exactly the newly selected row's wrapper aligned, via the real web API.
        expect(called).toHaveLength(1);
        expect(called[0].findAllByProps({ accessibilityLabel: '/compact, Compact context.. Sends now.' })).toHaveLength(1);
        expect(scrollCalls()).toBe(1);
    });
});
