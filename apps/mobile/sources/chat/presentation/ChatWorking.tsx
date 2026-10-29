import * as React from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { ChatTool } from '@trymuxr/contract';
import { withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';

/** What the agent is asking: the lines above its choices, and each choice with the key that answers it. */
export interface AskState {
    question: string[];
    choices: AskChoice[];
    answer: (choice: AskChoice) => void;
    /** An answer went out and the agent has not asked anything new yet. */
    sent: boolean;
}
export interface AskChoice { key: string; label: string; number?: string }

/** The agent's last lines, live, under what it is working on. Gone when it stops. */
export function RunningStrip({ task, lines, statusColor }: { task: string | undefined; lines: string[]; statusColor: string }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <View accessible accessibilityRole="summary" accessibilityLabel={`Working${task === undefined ? '' : `, ${task}`}. ${lines.join('. ')}`} style={{ marginHorizontal: 14, marginBottom: 6, paddingVertical: 8, paddingHorizontal: 12, gap: 6, borderRadius: 14, backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor }} />
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.textSecondary, fontSize: 13 }}>
                    <Text style={{ color: theme.colors.text, fontWeight: '600' }}>Working</Text>{task === undefined ? '' : ` · ${task}`}
                </Text>
            </View>
            {lines.length > 0 && (
                <View style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: theme.colors.surfaceHighest }}>
                    {lines.map((line, index) => (
                        <Text key={index} numberOfLines={1} ellipsizeMode="tail" style={{ color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, ...Typography.mono() }}>{line}</Text>
                    ))}
                </View>
            )}
        </View>
    );
}

/** A helper's reply as its own card: who it was, how the run went, the line it came back with. */
export function HelperCard({ tool }: { tool: ChatTool }): React.JSX.Element {
    const { theme } = useUnistyles();
    const failed = tool.outcome === 'failed';
    const title = tool.detail ?? 'Helper';
    const status = failed ? 'Failed' : tool.note ?? 'Done';
    return (
        <View accessible accessibilityLabel={`Helper ${title}. ${status}.${tool.result === undefined ? '' : ` ${tool.result}`}`} style={{ gap: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View aria-hidden style={{ width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHighest }}>
                    <Octicons name="rocket" size={14} color={theme.colors.textSecondary} />
                </View>
                <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 14.5, fontWeight: '600' }}>{title}</Text>
            </View>
            <Text numberOfLines={1} style={{ color: failed ? theme.colors.diff.error : theme.colors.textSecondary, fontSize: 12.5 }}>{status}</Text>
            {tool.result !== undefined && <Text numberOfLines={4} style={{ color: theme.colors.text, fontSize: 14, lineHeight: 20 }}>{tool.result}</Text>}
        </View>
    );
}

/** The question the agent is asking, with its choices as buttons; tapping one answers it. */
export function AskCard({ agentLabel, statusColor, question, choices, onAnswer, onOpenTerminal }: {
    agentLabel: string;
    statusColor: string;
    question: string[];
    choices: AskChoice[];
    onAnswer: (choice: AskChoice) => void;
    onOpenTerminal: () => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    return (
        <View accessibilityRole="alert" style={{ marginHorizontal: 14, marginBottom: 6, paddingVertical: 10, paddingHorizontal: 12, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: withAlpha(statusColor, 0.5), backgroundColor: withAlpha(statusColor, 0.12) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="help-circle" size={20} color={statusColor} />
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 14, fontWeight: '600' }}>{agentLabel} needs you</Text>
            </View>
            <ScrollView style={{ maxHeight: Math.max(160, height * 0.42) }} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {question.length > 0 && (
                    <View style={{ gap: 2 }}>
                        {question.map((line, index) => <Text key={index} selectable style={{ color: theme.colors.text, fontSize: 14, lineHeight: 20 }}>{line}</Text>)}
                    </View>
                )}
                <View style={{ gap: 6 }}>
                    {choices.map((choice) => (
                        <Pressable
                            key={choice.key}
                            onPress={() => onAnswer(choice)}
                            accessibilityRole="button"
                            accessibilityLabel={`Answer ${choice.label}`}
                            style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfaceHighest : theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider })}
                        >
                            {choice.number !== undefined && <View style={{ minWidth: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHighest }}><Text style={{ color: theme.colors.text, fontSize: 12.5, fontWeight: '600' }}>{choice.number}</Text></View>}
                            <Text numberOfLines={3} style={{ flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 14, lineHeight: 19 }}>{choice.label}</Text>
                        </Pressable>
                    ))}
                </View>
            </ScrollView>
            <Pressable onPress={onOpenTerminal} accessibilityRole="button" accessibilityLabel="Open terminal" style={({ pressed }) => ({ minHeight: 40, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 13, textDecorationLine: 'underline' }}>Open terminal</Text>
            </Pressable>
        </View>
    );
}

/** The moment after a tap: the agent has the answer and is still on its way. */
export function AnswerSent({ agentLabel, statusColor }: { agentLabel: string; statusColor: string }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <View accessible accessibilityRole="summary" accessibilityLabel={`Answer sent. ${agentLabel} is continuing.`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor }} />
            <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: theme.colors.textSecondary, fontSize: 13 }}>
                <Text style={{ color: theme.colors.text, fontWeight: '600' }}>Answer sent</Text>{` · ${agentLabel} is continuing`}
            </Text>
        </View>
    );
}
