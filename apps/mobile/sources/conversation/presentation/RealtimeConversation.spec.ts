import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

// The exact reason a real Codex 401 produces: captured from
// the realtime voice adapter signalling chatgpt.com with a rejected credential.
const CODEX_401 = 'Codex Voice signaling failed (401): "error": "message": "Could not parse your'
    + ' authentication token. Please try signing in again.", "type": null, "code":'
    + ' "unauthorized_unknown", "param": null , "status": 401 Run codex login again.';

const transport = vi.hoisted(() => ({
    state: 'disconnected',
    detail: undefined as string | undefined,
}));
const viewport = vi.hoisted(() => ({ width: 270, height: 594 }));
const conversation = vi.hoisted(() => ({
    turns: [] as Array<{ id: number; role: 'user' | 'agent'; text: string }>,
    scrolls: [] as Array<{ y: number; animated: boolean }>,
}));

vi.mock('react-native', () => {
    class ScrollView extends React.Component<{ children?: React.ReactNode }> {
        scrollTo(options: { y: number; animated: boolean }): void {
            conversation.scrolls.push(options);
        }
        render() { return this.props.children ?? null; }
    }
    return {
        BackHandler: { addEventListener: () => ({ remove: () => {} }) },
        Pressable: 'Pressable',
        ScrollView,
        useWindowDimensions: () => viewport,
        View: 'View',
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn(), impactAsync: vi.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
vi.mock('react-native-reanimated', () => ({ default: { View: 'View' }, FadeIn: { duration: () => ({}) }, FadeOut: { duration: () => ({}) } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/catalog/store', () => ({
    useSession: () => ({ metadata: { machineId: 'w7:p1' } }),
    useMachine: () => ({ metadata: { displayName: 'extreme' } }),
}));
vi.mock('@/catalog', () => ({ getRigActivityIndicators: () => [], getRigIdentity: () => undefined }));
vi.mock('./RealtimeSessionVisual', () => ({ RealtimeSessionVisual: 'RealtimeSessionVisual' }));
vi.mock('../application/realtimeSessionState', () => ({
    rememberedRealtimeSession: () => 'session-1',
    startRealtimeSession: vi.fn(),
    stopRealtimeSession: vi.fn(),
    toggleRealtimeMuted: vi.fn(),
    useRealtimeMuted: () => false,
    useRealtimeSessionState: () => ({ state: transport.state, detail: transport.detail }),
    useRealtimeTurns: () => conversation.turns,
    useRealtimeWatching: () => true,
}));

import { ScrollView as MockScrollView } from 'react-native';
import { RealtimeConversation } from './RealtimeConversation';

function visibleTexts(root: any): string[] {
    return root.findAllByType('Text').map((node: any) => {
        const children = node.props.children;
        return (Array.isArray(children) ? children : [children]).filter((child: unknown) => typeof child === 'string').join('');
    });
}

type Row = readonly [y: number, height: number];

/**
 * Lays the transcript out the way the platform reports it -- the window, each
 * row, then the content size including whatever room the screen added under
 * the newest row -- and returns where the screen scrolled and that room.
 */
function driveTranscriptLayout(renderer: any, viewport: number, rows: readonly Row[]): { target: number; tail: number } {
    const root = renderer.root;
    const transcript = () => root.findAllByType(MockScrollView).find((node: any) => typeof node.props.onContentSizeChange === 'function');
    const inset = () => {
        const style = transcript().props.contentContainerStyle;
        return style.paddingBottom ?? style.paddingVertical ?? 0;
    };
    const views = root.findAllByType('View').filter((node: any) => typeof node.props.onLayout === 'function').slice(-rows.length);
    if (views.length !== rows.length) throw new Error(`expected ${rows.length} transcript rows, got ${views.length}`);
    const [newestY, newestHeight] = rows.at(-1)!;
    conversation.scrolls.length = 0;
    TestRenderer.act(() => {
        transcript().props.onLayout({ nativeEvent: { layout: { height: viewport } } });
        views.forEach((view: any, index: number) => view.props.onLayout({ nativeEvent: { layout: { y: rows[index]![0], height: rows[index]![1] } } }));
    });
    for (let frame = 0; frame < 4; frame += 1) {
        TestRenderer.act(() => {
            transcript().props.onContentSizeChange(320, newestY + newestHeight + inset());
            vi.runAllTimers();
        });
    }
    return { target: conversation.scrolls.at(-1)?.y ?? -1, tail: inset() - 8 };
}

/** The window opens on a whole row, keeps the newest row whole, and can be scrolled to. */
function expectWholeRows(viewport: number, rows: readonly Row[], { target, tail }: { target: number; tail: number }): void {
    for (const [y, height] of rows) expect(target > y && target < y + height, `window opens inside the row at ${y}`).toBe(false);
    const [newestY, newestHeight] = rows.at(-1)!;
    if (newestHeight + 16 <= viewport) expect(newestY + newestHeight).toBeLessThanOrEqual(target + viewport);
    else expect(target).toBe(newestY - 8);
    expect(newestY + newestHeight + 8 + tail).toBeGreaterThanOrEqual(target + viewport);
}

describe('realtime failure banner', () => {
    it('tells the person their Codex sign-in expired and keeps the whole provider error behind Details', () => {
        transport.state = 'disconnected';
        transport.detail = CODEX_401;
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
        });
        const root = renderer!.root;

        // Collapsed: a plain sentence and the remedy, with no status code, no
        // JSON and no fragment of the provider's words anywhere on screen.
        const collapsed = visibleTexts(root);
        expect(collapsed).toContain('Codex needs a new sign-in.');
        expect(collapsed).toContain('Sign in to Codex on extreme, then start voice again.');
        expect(collapsed.join(' ')).not.toContain('401');
        expect(collapsed.join(' ')).not.toContain('"error"');

        TestRenderer.act(() => {
            root.findByProps({ accessibilityLabel: 'Show details' }).props.onPress();
        });

        // Expanded: the provider's words, whole — the truncation the person
        // used to be handed instead of an explanation.
        expect(visibleTexts(root)).toContain(CODEX_401);

    });

    it('says nothing at all while a call is still connecting', () => {
        transport.state = 'connecting';
        transport.detail = 'Connecting secure voice media';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
        });

        // Every successful call passes through here carrying a detail. It must
        // neither accuse the person of a failure that has not happened nor
        // narrate the provider's progress at them.
        const texts = visibleTexts(renderer!.root);
        expect(texts.join(' ')).not.toContain('Connecting secure voice media');
        expect(texts.join(' ')).not.toContain('Voice stopped.');
        expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Show details' })).toHaveLength(0);
    });
});

describe('realtime transcript layout', () => {
    // Rows and windows measured on the PWA replaying the owner's conversation.
    const OWNER = [
        ['user', 'What is the first mate doing'],
        ['agent', 'I couldn’t find an agent named “First Mate,” so I can’t confirm what they’re doing.'],
        ['user', 'Okay, what is crane doing'],
        ['agent', 'I couldn’t find an agent matching “Crane,” so I can’t confirm what they’re doing.'],
        ['user', 'Which agents can you find'],
        ['agent', 'I couldn’t retrieve the agent list, so I can’t reliably name any available agents.'],
        ['user', 'What can you do right now'],
        ['agent', 'I can read agent status and output, list recent activity, start or prompt agents, and navigate the app; tell me which one you want.'],
        ['user', 'How many agents are running right now'],
        ['agent', 'I couldn’t retrieve the live agent list, so I can’t determine how many are running right now.'],
        ['user', 'Why? What exactly is the error you’re hitting'],
        ['agent', 'The only error I got was, “The work request could not be completed. No action was confirmed.” It didn’t include any further details.'],
    ] as const;
    const SHORT_ROWS: Row[] = [[8, 42], [60, 84], [154, 21], [185, 84], [279, 21], [310, 84], [404, 21], [435, 126], [571, 42], [623, 84], [717, 42], [769, 126]];
    const WIDE_ROWS: Row[] = [[8, 21], [39, 63], [112, 21], [143, 63], [216, 21], [247, 63], [320, 21], [351, 84], [445, 21], [476, 63], [549, 42], [601, 84]];
    const show = (count: number) => {
        conversation.turns = OWNER.slice(0, count).map(([role, text], id) => ({ id, role, text }));
    };

    it('never opens the window inside an older row under Listening or Thinking', () => {
        vi.useFakeTimers();
        try {
            // 270x594: the owner's next question is pending, and scrolling to
            // the end would open the window 16dp inside the answer above it.
            transport.state = 'thinking';
            transport.detail = undefined;
            show(11);
            let renderer: any;
            TestRenderer.act(() => {
                renderer = TestRenderer.create(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
            });
            expect(visibleTexts(renderer.root)).toContain('Thinking…');
            const thinking = driveTranscriptLayout(renderer, 128, SHORT_ROWS.slice(0, 11));
            expectWholeRows(128, SHORT_ROWS.slice(0, 11), thinking);
            expect(thinking).toEqual({ target: 709, tail: 70 });

            // The answer arrives taller than the window: it reads from its start.
            transport.state = 'connected';
            show(12);
            TestRenderer.act(() => {
                renderer.update(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
            });
            expect(visibleTexts(renderer.root)).toContain('Listening');
            const answered = driveTranscriptLayout(renderer, 128, SHORT_ROWS);
            expectWholeRows(128, SHORT_ROWS, answered);
            expect(answered).toEqual({ target: 761, tail: 0 });

            // 360x640: scrolling to the end would leave the last 20dp of an
            // older answer as a fragment under Listening.
            viewport.width = 360;
            viewport.height = 640;
            TestRenderer.act(() => {
                renderer.update(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
            });
            const listening = driveTranscriptLayout(renderer, 174, WIDE_ROWS);
            expectWholeRows(174, WIDE_ROWS, listening);
            expect(listening).toEqual({ target: 541, tail: 22 });

            // A conversation that fits needs neither scrolling nor room.
            show(2);
            TestRenderer.act(() => {
                renderer.update(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
            });
            expect(driveTranscriptLayout(renderer, 174, WIDE_ROWS.slice(0, 2))).toEqual({ target: 0, tail: 0 });

            for (const label of ['Minimize realtime conversation', 'Mute microphone', 'End realtime conversation']) {
                const control = renderer.root.findByProps({ accessibilityLabel: label });
                expect(control.props.style.width).toBeGreaterThanOrEqual(44);
                expect(control.props.style.height).toBeGreaterThanOrEqual(44);
            }
        } finally {
            viewport.width = 270;
            viewport.height = 594;
            conversation.turns = [];
            conversation.scrolls.length = 0;
            vi.useRealTimers();
        }
    });
});
