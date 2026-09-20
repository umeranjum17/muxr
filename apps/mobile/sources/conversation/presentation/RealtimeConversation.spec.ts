import { appendFileSync } from 'node:fs';
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

function recordLayoutEvidence(value: { viewport: { width: number; height: number }; transcriptHeight: number; contentHeight: number; rowYs: number[]; target: number }): void {
    const path = process.env.MUXR_REALTIME_EVIDENCE_FILE;
    if (path === undefined) return;
    appendFileSync(path, `${JSON.stringify({ event: 'layout.measurement', ...value })}\n`);
}

function driveTranscriptLayout(renderer: any, transcriptViewportHeight: number, contentHeight: number, rowYs: number[]): number {
    const root = renderer.root;
    const transcript = root.findAllByType(MockScrollView).find((node: any) => typeof node.props.onContentSizeChange === 'function');
    if (!transcript) throw new Error('transcript ScrollView was not rendered');
    const rows = root.findAllByType('View').filter((node: any) => typeof node.props.onLayout === 'function').slice(-rowYs.length);
    if (rows.length !== rowYs.length) throw new Error(`expected ${rowYs.length} transcript rows, got ${rows.length}`);
    TestRenderer.act(() => {
        transcript.props.onLayout({ nativeEvent: { layout: { height: transcriptViewportHeight } } });
        transcript.props.onContentSizeChange(320, contentHeight);
        rows.forEach((row: any, index: number) => row.props.onLayout({ nativeEvent: { layout: { y: rowYs[index], height: 50 } } }));
        vi.runAllTimers();
    });
    return conversation.scrolls.at(-1)?.y ?? -1;
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
    it('keeps Listening → Thinking → response on measured row boundaries at both short viewports', () => {
        vi.useFakeTimers();
        try {
            transport.state = 'connected';
            transport.detail = undefined;
            conversation.turns = [
                { id: 1, role: 'user', text: 'Which agents are running?' },
                { id: 2, role: 'agent', text: 'I am checking the live roster.' },
            ];
            conversation.scrolls.length = 0;
            let renderer: any;
            TestRenderer.act(() => {
                renderer = TestRenderer.create(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
            });
            expect(visibleTexts(renderer.root)).toContain('Listening');
            expect(viewport).toEqual({ width: 270, height: 594 });
            const firstTarget = driveTranscriptLayout(renderer, 220, 620, [0, 110]);
            recordLayoutEvidence({ viewport: { ...viewport }, transcriptHeight: 220, contentHeight: 620, rowYs: [0, 110], target: firstTarget });
            expect([0, 110]).toContain(firstTarget);

            viewport.width = 360;
            viewport.height = 640;
            transport.state = 'thinking';
            conversation.turns = [
                ...conversation.turns,
                { id: 3, role: 'user', text: 'What is crane doing?' },
            ];
            TestRenderer.act(() => {
                renderer.update(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
            });
            expect(visibleTexts(renderer.root)).toContain('Thinking…');
            expect(viewport).toEqual({ width: 360, height: 640 });
            const clippedTarget = driveTranscriptLayout(renderer, 220, 370, [0, 110, 240]);
            recordLayoutEvidence({ viewport: { ...viewport }, transcriptHeight: 220, contentHeight: 370, rowYs: [0, 110, 240], target: clippedTarget });
            expect(clippedTarget).toBe(110);
            const secondTarget = driveTranscriptLayout(renderer, 280, 700, [0, 110, 240]);
            recordLayoutEvidence({ viewport: { ...viewport }, transcriptHeight: 280, contentHeight: 700, rowYs: [0, 110, 240], target: secondTarget });
            expect([0, 110, 240]).toContain(secondTarget);

            transport.state = 'connected';
            conversation.turns = [
                ...conversation.turns,
                { id: 4, role: 'agent', text: 'crane is running its health check.' },
            ];
            TestRenderer.act(() => {
                renderer.update(React.createElement(RealtimeConversation, { visible: true, onClose: () => {} }));
            });
            expect(visibleTexts(renderer.root)).toContain('Listening');
            const finalTarget = driveTranscriptLayout(renderer, 280, 800, [0, 110, 240, 350]);
            recordLayoutEvidence({ viewport: { ...viewport }, transcriptHeight: 280, contentHeight: 800, rowYs: [0, 110, 240, 350], target: finalTarget });
            expect([0, 110, 240, 350]).toContain(finalTarget);
            expect(finalTarget).toBe(350);

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
