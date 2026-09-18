import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

// The exact reason a real Codex 401 produces: captured from
// plugins/voice/stream.mjs signalling chatgpt.com with a rejected credential.
const CODEX_401 = 'Codex Voice signaling failed (401): "error": "message": "Could not parse your'
    + ' authentication token. Please try signing in again.", "type": null, "code":'
    + ' "unauthorized_unknown", "param": null , "status": 401 Run codex login again.';

const transport = vi.hoisted(() => ({
    state: 'disconnected',
    detail: undefined as string | undefined,
}));

vi.mock('react-native', () => ({
    BackHandler: { addEventListener: () => ({ remove: () => {} }) },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    useWindowDimensions: () => ({ width: 270, height: 594 }),
    View: 'View',
}));
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
    useRealtimeTurns: () => [],
    useRealtimeWatching: () => true,
}));

import { RealtimeConversation } from './RealtimeConversation';

function visibleTexts(root: any): string[] {
    return root.findAllByType('Text').map((node: any) => {
        const children = node.props.children;
        return (Array.isArray(children) ? children : [children]).filter((child: unknown) => typeof child === 'string').join('');
    });
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
