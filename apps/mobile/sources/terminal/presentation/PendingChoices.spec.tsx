import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * The answer band over a blocked agent's terminal. It drives the real
 * PendingChoices through the real terminal-colour resolution and reads the band
 * it actually renders, because two review findings lived exactly here: the band
 * was a translucent fixed-canvas overlay (terminal text showed through, and a
 * background tuned in Settings no longer matched it), and its top edge landed
 * mid-line and clipped the terminal row above.
 */

const currentOverrides = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const readText = vi.hoisted(() => ({ value: '' }));

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-reanimated', () => {
    const fade: Record<string, () => unknown> = {};
    fade.duration = () => fade;
    fade.reduceMotion = () => fade;
    return { default: { View: 'AnimatedView' }, FadeIn: fade, FadeOut: fade, ReduceMotion: { System: 'system' } };
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: {
        colors: {
            text: '#fff', textSecondary: '#999',
            terminalChrome: { canvas: '#0c0c0b', cluster: '#303030', clusterPressed: '#484845' },
        },
    } }),
}));
vi.mock('@/catalog/sync', () => ({ sync: { request: vi.fn(async () => ({ text: readText.value })) } }));
vi.mock('@/catalog/store', () => ({ useLocalSetting: () => currentOverrides.value }));
vi.mock('@/components/haptics', () => ({ hapticsSelection: () => undefined }));
vi.mock('@/constants/Typography', () => ({ Typography: { mono: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { alert: () => undefined } }));
vi.mock('@/components/ui', () => ({ withAlpha: (color: string) => color }));

import { PendingChoices } from './PendingChoices';

const SCREEN = ['Which approach should I take?', '\u276f 1. Option one', '  2. Option two', '  3. Option three'].join('\n');

async function mount(props: { lineHeight?: number; gridInset?: number; columns?: number }) {
    readText.value = SCREEN;
    let renderer: any;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(
            <PendingChoices sessionId="s" waiting channel={{ sendText: () => undefined }} onVisibilityChange={() => undefined} {...props} />,
        );
    });
    await TestRenderer.act(async () => { await Promise.resolve(); });
    return renderer!;
}

const band = (renderer: any) => renderer.root.findByType('AnimatedView');
const stack = (renderer: any) => renderer.root.findAll((node: any) => typeof node.props.onLayout === 'function')[0];

describe('opaque answer-chip band over the terminal', () => {
    it('paints the band in the terminal background the person tuned, and ends it on a row boundary', async () => {
        currentOverrides.value = { background: '#123456' };
        const renderer = await mount({ lineHeight: 18, gridInset: 5 });

        // The band is solid, in the tuned background, not a translucent default.
        const painted = band(renderer).props.style;
        expect(painted.backgroundColor).toBe('#123456');
        expect(String(painted.backgroundColor)).not.toMatch(/^rgba/);

        // A chip stack is measured, and the band's top edge is padded so the
        // whole band plus the grid inset is a whole number of terminal rows.
        await TestRenderer.act(async () => { stack(renderer).props.onLayout({ nativeEvent: { layout: { height: 36 } } }); });
        const top = band(renderer).props.style.paddingTop;
        const bottom = band(renderer).props.style.paddingBottom;
        expect(((top + 36 + bottom - 5) % 18 + 18) % 18).toBe(0);
        expect(top).toBeGreaterThan(bottom);

        // Retuning the terminal colour while the band is up moves the band with it.
        currentOverrides.value = { background: '#abcdef' };
        await TestRenderer.act(async () => { renderer.update(
            <PendingChoices sessionId="s" waiting channel={{ sendText: () => undefined }} onVisibilityChange={() => undefined} lineHeight={18} gridInset={5} />,
        ); });
        expect(band(renderer).props.style.backgroundColor).toBe('#abcdef');
    });

    it('falls back to the renderer default background and a plain pad before any grid is known', async () => {
        currentOverrides.value = {};
        const renderer = await mount({});
        const painted = band(renderer).props.style;
        expect(painted.backgroundColor).toBe('#0c0c0b');
        expect(painted.paddingTop).toBe(painted.paddingBottom);
    });
});

/** Claude Code's folder-trust question as Herdr reads it off the pane: no numbers, "No, exit" highlighted. */
const TRUST_SCREEN = [
    '─'.repeat(60),
    ' Accessing workspace:',
    '',
    ' /home/user/notes-app',
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    ' project, or work from your team). If not, take a moment to review what\'s in this folder first.',
    '',
    ' Security guide',
    '',
    ' \u276f No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm \u00b7 Esc to cancel',
    '',
    '',
].join('\n');

/** Claude Code 2.1.296's MCP question at a ~37-column phone grid: two labels wrap. */
const MCP_SCREEN = [
    ' New MCP server found in this project',
    '',
    '    Use this MCP server',
    '    Use this and all future MCP',
    '    servers in this project',
    '  \u276f Continue without using this MCP',
    '    server',
    '',
    ' Enter to confirm \u00b7 Esc to cancel',
    '',
    '',
].join('\n');

/** One run of Herdr's ANSI read: it resets and sets the background before every run. */
const run = (background: string, text: string) => `\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;${background}m${text}`;
const frame = (...runs: string[]) => [run('10;10;10', '  '), run('20;20;20', '\u2503'), ...runs, '\u001b[0m'].join('');

/**
 * OpenCode 1.18's permission dialog as Herdr reads it at a 33-column phone
 * grid: the row is cut off before Reject, and Allow always is selected, which
 * shows only as its background.
 */
const OPENCODE_SCREEN = [
    frame(run('30;30;30', '  \u25b3 Permission required        ')),
    frame(run('30;30;30', '    \u2190 Access external          ')),
    frame(run('30;30;30', '      directory /etc           ')),
    frame(run('30;30;30', '                               ')),
    frame(run('30;30;30', '  '), run('30;30;30', ' Allow once '), run('30;30;30', ' '), run('245;167;66', ' Allow always '), run('30;30;30', '  ')),
    frame(run('30;30;30', '                               ')),
    frame(run('30;30;30', '  ctrl+f fullscreen  \u21c6 select  ')),
    frame(run('30;30;30', '                               ')),
].join('\n');

describe('one-tap answers to a question with no numbers', () => {    it('answers the folder-trust question by moving to the tapped row, never by Enter on the highlighted Exit', async () => {
        currentOverrides.value = {};
        readText.value = TRUST_SCREEN;
        const sent: string[] = [];
        let renderer: any;
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                <PendingChoices sessionId="s" waiting channel={{ sendText: (text) => sent.push(text) }} onVisibilityChange={() => undefined} columns={44} />,
            );
        });
        await TestRenderer.act(async () => { await Promise.resolve(); });

        const chips = renderer.root.findAll((node: any) => node.type === 'Pressable');
        expect(chips.map((chip: any) => chip.props.accessibilityLabel)).toEqual(['Answer No, exit', 'Answer Yes, I trust this folder']);
        // No number badge: the agent shows none, and the bytes sent are not one.
        expect(JSON.stringify(renderer.toJSON())).not.toContain('\\u001b');

        await TestRenderer.act(async () => { chips[1].props.onPress(); });
        expect(sent).toEqual(['\u001b[B\r']);
    });

    it('joins labels wrapped at the phone grid so a chip never answers another row', async () => {
        currentOverrides.value = {};
        readText.value = MCP_SCREEN;
        const sent: string[] = [];
        let renderer: any;
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                <PendingChoices sessionId="s" waiting channel={{ sendText: (text) => sent.push(text) }} onVisibilityChange={() => undefined} columns={37} />,
            );
        });
        await TestRenderer.act(async () => { await Promise.resolve(); });

        const chips = renderer.root.findAll((node: any) => node.type === 'Pressable');
        expect(chips.map((chip: any) => chip.props.accessibilityLabel)).toEqual([
            'Answer Use this MCP server',
            'Answer Use this and all future MCP servers in this project',
            'Answer Continue without using this MCP server',
        ]);

        await TestRenderer.act(async () => { chips[1].props.onPress(); });
        expect(sent).toEqual(['\u001b[A\r']);
    });

    it('answers OpenCode\'s permission row from the selected button, with the labels the narrow row cuts off', async () => {
        currentOverrides.value = {};
        readText.value = OPENCODE_SCREEN;
        const sent: string[] = [];
        let renderer: any;
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(
                <PendingChoices sessionId="s" waiting channel={{ sendText: (text) => sent.push(text) }} onVisibilityChange={() => undefined} columns={33} />,
            );
        });
        await TestRenderer.act(async () => { await Promise.resolve(); });

        const chips = renderer.root.findAll((node: any) => node.type === 'Pressable');
        expect(chips.map((chip: any) => chip.props.accessibilityLabel)).toEqual(['Answer Allow once', 'Answer Allow always', 'Answer Reject']);

        await TestRenderer.act(async () => { chips[2].props.onPress(); });
        expect(sent).toEqual(['\u001b[C\r']);
    });
});
