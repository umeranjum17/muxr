import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { ChatMessage, ChatTool } from '@trymuxr/contract';
import { withAlpha } from '@/components/ui';
import type { ChatState } from '../application/useChat';
import { ChatImages } from './ChatImages';
import { ChatSteps, DiffSheet } from './ChatSteps';

export interface ChatPaneProps {
    sessionId: string;
    state: ChatState;
    /** "Claude", "Pi": who is answering. */
    agentLabel: string;
    working: boolean;
    needsYou: boolean;
    /** What the agent is working on, from the same task title the header leads with. */
    task: string | undefined;
    statusColor: string;
    /** The model the agent reports; absent when it has not said. */
    model: string | undefined;
    ink: string;
    onOpenTerminal: () => void;
}

const NEAR_BOTTOM = 80;

/** The shared lazy code-surfaces chunk: it keeps Markdown out of the eager entry. */
const ChatMarkdown = React.lazy(() => import('@/components/code/codeSurfaces').then(({ MarkdownView }) => ({ default: MarkdownView })));

function clock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The person's words sit in a grey bubble on the right; the agent's are plain text across the column. */
function Message({ sessionId, message, live, ink, onFullDiff, onOpenTerminal }: { sessionId: string; message: ChatMessage; live: boolean; ink: string; onFullDiff: (tool: ChatTool) => void; onOpenTerminal: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const mine = message.role === 'user';
    if (mine) {
        return (
            <View style={{ gap: 6 }}>
                {message.images !== undefined && <ChatImages sessionId={sessionId} images={message.images} mine />}
                {message.text !== '' && <View accessible accessibilityLabel={`You, ${clock(message.at)}. ${message.text}`} style={{ alignSelf: 'flex-end', maxWidth: '84%', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: theme.colors.surfaceHighest }}>
                    <Text selectable style={{ color: theme.colors.text, fontSize: 15.5, lineHeight: 22 }}>{message.text}</Text>
                </View>}
            </View>
        );
    }
    return (
        <View style={{ gap: 2 }}>
            {message.text !== '' && <View accessible accessibilityLabel={`Agent, ${clock(message.at)}. ${message.text}`}>
                <React.Suspense fallback={null}><ChatMarkdown markdown={message.text} /></React.Suspense>
            </View>}
            {message.images !== undefined && <View style={{ paddingVertical: 4 }}><ChatImages sessionId={sessionId} images={message.images} mine={false} /></View>}
            {message.tools !== undefined && <ChatSteps tools={message.tools} live={live} ink={ink} onFullDiff={onFullDiff} onOpenTerminal={onOpenTerminal} />}
        </View>
    );
}

function Notice({ title, body, action }: { title: string; body: string; action?: { label: string; onPress: () => void } }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <View style={{ alignItems: 'center', gap: 6, padding: 24 }}>
            <Text style={{ color: theme.colors.text, fontSize: 17, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 14, textAlign: 'center' }}>{body}</Text>
            {action !== undefined && <Pressable onPress={action.onPress} accessibilityRole="button" style={{ marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: withAlpha(theme.colors.text, 0.08) }}>
                <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{action.label}</Text>
            </Pressable>}
        </View>
    );
}

/**
 * An agent's conversation, drawn over its terminal. The terminal stays
 * mounted underneath so its grid never changes; this only covers it.
 */
export function ChatPane(props: ChatPaneProps): React.JSX.Element {
    const { theme } = useUnistyles();
    const accent = theme.colors.accent;
    const onAccent = theme.dark ? '#111111' : '#ffffff';
    const list = React.useRef<ScrollView>(null);
    const [tool, setTool] = React.useState<ChatTool | null>(null);
    const stuck = React.useRef(true);
    const { state } = props;
    const messages = state.status === 'ready' ? state.messages : [];

    let body: React.ReactNode;
    if (state.status === 'loading') body = <View style={{ padding: 24 }}><ActivityIndicator color={theme.colors.textSecondary} /></View>;
    else if (state.status === 'unavailable') body = <Notice title="No messages yet" body={`${props.agentLabel} has not started a conversation here. It shows up as soon as it does.`} />;
    else if (state.status === 'failed') body = <Notice title="Chat is not available" body={state.outdatedHost ? 'This computer runs an older muxr. Update it to read chats here.' : state.message} action={{ label: 'Open terminal', onPress: props.onOpenTerminal }} />;
    else if (messages.length === 0) body = <Notice title="No messages yet" body={`Ask ${props.agentLabel} about this workspace. Replies show up here as whole messages.`} />;
    else body = messages.map((message, index) => <Message key={message.id} sessionId={props.sessionId} message={message} live={props.working && index === messages.length - 1} ink={props.ink} onFullDiff={setTool} onOpenTerminal={props.onOpenTerminal} />);

    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: props.ink }}>
            <ScrollView
                ref={list}
                style={{ flex: 1 }}
                contentContainerStyle={{ flexGrow: 1, width: '100%', maxWidth: 640, alignSelf: 'center', justifyContent: messages.length === 0 ? 'center' : 'flex-end', gap: 12, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 }}
                keyboardShouldPersistTaps="handled"
                onScroll={(event) => {
                    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                    stuck.current = contentSize.height - contentOffset.y - layoutMeasurement.height < NEAR_BOTTOM;
                }}
                scrollEventThrottle={64}
                onContentSizeChange={() => { if (stuck.current) list.current?.scrollToEnd({ animated: false }); }}
                // The working line and the needs-you card shrink the list: keep the newest message in view.
                onLayout={() => { if (stuck.current) list.current?.scrollToEnd({ animated: false }); }}
            >
                {body}
            </ScrollView>

            {props.needsYou
                ? (
                    <View accessibilityRole="alert" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginHorizontal: 14, marginBottom: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: withAlpha(props.statusColor, 0.5), backgroundColor: withAlpha(props.statusColor, 0.12) }}>
                        <Ionicons name="warning-outline" size={22} color={props.statusColor} />
                        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 120 }}>
                            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 14, fontWeight: '600' }}>{props.agentLabel} needs you</Text>
                            <Text numberOfLines={2} style={{ color: theme.colors.textSecondary, fontSize: 13 }}>It is waiting for an answer in the terminal</Text>
                        </View>
                        <Pressable onPress={props.onOpenTerminal} accessibilityRole="button" accessibilityLabel="Open terminal" style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: accent, opacity: pressed ? 0.7 : 1 })}>
                            <Text style={{ color: onAccent, fontSize: 13.5, fontWeight: '600' }}>Open terminal</Text>
                            <Ionicons name="chevron-forward" size={14} color={onAccent} />
                        </Pressable>
                    </View>
                )
                : props.working && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 18, minHeight: 28 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: props.statusColor }} />
                        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 13 }}>
                            <Text style={{ color: theme.colors.text, fontWeight: '600' }}>Working</Text>{props.task === undefined ? '' : ` · ${props.task}`}
                        </Text>
                    </View>
                )}

            {props.model !== undefined && (
                <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 6 }}>
                    <View accessible accessibilityLabel={`Model ${props.model}`} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface }}>
                        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13 }}>{props.model}</Text>
                    </View>
                </View>
            )}

            <DiffSheet tool={tool} onClose={() => setTool(null)} />
        </View>
    );
}
