import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * The agent's changes without the quick-actions ring: the header pill and the
 * Pane actions row. The pill is the J2 readiness fix — it must appear only
 * while the working tree is dirty, inside the header row that already exists
 * (a late row would re-attach the terminal), and the menu must always carry a
 * Changes entry that opens the same review.
 */

vi.mock('react-native', () => ({
    StyleSheet: { hairlineWidth: 0.5 },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (value: unknown) => value },
    useUnistyles: () => ({ theme: { colors: { text: '#fff', textSecondary: '#999', divider: '#333', surfacePressed: '#222', surfaceHigh: '#1a1a1a', surfaceHighest: '#2a2a2a' } } }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// The real English table, so the pill's words are the app's words.
vi.mock('@/text', async () => {
    const { en } = await import('@/text/_default');
    const lookup = (key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
    return { t: (key: string, params?: Record<string, unknown>) => {
        const value = lookup(key);
        return typeof value === 'function' ? (value as (p: unknown) => string)(params) : value;
    } };
});

import { HeaderChangesPill, PaneActionsChangesRow } from './ChangesEntries';

const textsOf = (renderer: unknown): string[] => {
    const words: string[] = [];
    const walk = (node: any) => {
        if (node === null || typeof node !== 'object') return;
        if (node.type === 'Text' && typeof node.children?.[0] === 'string') words.push(node.children[0]);
        for (const child of node.children ?? []) walk(child);
    };
    walk((renderer as { toJSON: () => any }).toJSON());
    return words;
};

async function mount(element: React.ReactElement) {
    let renderer: any;
    await TestRenderer.act(async () => { renderer = TestRenderer.create(element); });
    await TestRenderer.act(async () => { await Promise.resolve(); });
    return renderer!;
}

describe('changes discoverability', () => {
    it('shows the header pill only while there are changes, and opens the review from it', async () => {
        const onPress = vi.fn();
        const withChanges = await mount(<HeaderChangesPill count={3} onPress={onPress} />);
        expect(textsOf(withChanges)).toContain('3 files changed');
        const pressable = withChanges.root.findByProps({ accessibilityRole: 'button' });
        expect(pressable.props.accessibilityLabel).toBe('Review changes, 3 files changed');
        await TestRenderer.act(async () => { pressable.props.onPress(); });
        expect(onPress).toHaveBeenCalledOnce();

        // A narrow header shows the count alone; the spoken label keeps the words.
        const compact = await mount(<HeaderChangesPill count={3} compact onPress={onPress} />);
        expect(textsOf(compact)).toEqual(['3']);
        expect(compact.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel).toBe('Review changes, 3 files changed');

        const zero = await mount(<HeaderChangesPill count={0} onPress={onPress} />);
        expect(zero.toJSON()).toBeNull();
        const unloaded = await mount(<HeaderChangesPill count={null} onPress={onPress} />);
        expect(unloaded.toJSON()).toBeNull();
    });

    it('always lists Changes in Pane actions, with the count when there is one', async () => {
        const onPress = vi.fn();
        const dirty = await mount(<PaneActionsChangesRow count={3} onPress={onPress} />);
        expect(textsOf(dirty)).toContain('Changes');
        expect(textsOf(dirty)).toContain('3');
        expect(dirty.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel).toBe('Review changes, 3 files changed');

        const clean = await mount(<PaneActionsChangesRow count={null} onPress={onPress} />);
        expect(textsOf(clean)).toContain('Changes');
        expect(clean.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel).toBe('Review changes');
        await TestRenderer.act(async () => { clean.root.findByProps({ accessibilityRole: 'button' }).props.onPress(); });
        expect(onPress).toHaveBeenCalledOnce();
    });
});
