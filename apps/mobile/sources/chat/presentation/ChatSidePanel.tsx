import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { ChangesFile } from '@trymuxr/contract';

/** The right-hand panel's width: the redo's 228 at 1280, the roomier 268 from 1400. */
export function sidePanelWidth(windowWidth: number): number {
    return windowWidth >= 1400 ? 268 : 228;
}

const FILES_SHOWN = 6;

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <View style={{ gap: 6, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: theme.colors.divider }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>{title}</Text>
            {children}
        </View>
    );
}

/**
 * What this agent is working on, beside its chat on a wide window: the
 * project, what changed, what it shared and where its usage is. It lists what
 * the screen already holds and opens the same pages the ⋮ menu does.
 */
export function ChatSidePanel(props: {
    width: number;
    project: string | undefined;
    who: string;
    tabCount: number;
    files: readonly ChangesFile[];
    changesCount: number | null;
    artifactsCount: number | null;
    onOpenChanges: () => void;
    onOpenArtifacts: () => void;
    onOpenUsage: () => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const link = (label: string, onPress: () => void, value?: string) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={value === undefined ? label : `${label}, ${value}`} style={({ pressed }) => ({ minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 14, fontWeight: '500' }}>{label}</Text>
            {value !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{value}</Text>}
            <Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} />
        </Pressable>
    );
    return (
        <View style={{ width: props.width, borderLeftWidth: 0.5, borderLeftColor: theme.colors.divider, backgroundColor: theme.colors.header.background }}>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 24 }}>
                <Section title="Project">
                    <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>{props.project ?? 'This workspace'}</Text>
                    <Text numberOfLines={2} style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{props.who}{props.tabCount > 0 ? ` · ${props.tabCount} ${props.tabCount === 1 ? 'tab' : 'tabs'} open` : ''}</Text>
                </Section>
                <Section title="Changes">
                    {props.files.length === 0
                        ? <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{props.changesCount === 0 ? 'No changes yet' : 'Nothing to list yet'}</Text>
                        : props.files.slice(0, FILES_SHOWN).map((file) => (
                            <View key={file.path} accessible accessibilityLabel={`${file.title}, ${file.added} added, ${file.deleted} removed`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <Text numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 13, fontFamily: 'IBMPlexMono-Regular' }}>{file.title}</Text>
                                <Text style={{ color: theme.colors.gitAddedText, fontSize: 12 }}>{file.added}</Text>
                                <Text style={{ color: theme.colors.gitRemovedText, fontSize: 12 }}>{file.deleted}</Text>
                            </View>
                        ))}
                    {link('All changes', props.onOpenChanges, props.changesCount === null ? undefined : String(props.changesCount))}
                </Section>
                <Section title="Shared">
                    {link('Shared Artifacts', props.onOpenArtifacts, props.artifactsCount === null ? undefined : String(props.artifactsCount))}
                </Section>
                <Section title="Usage">
                    {link('Usage', props.onOpenUsage)}
                </Section>
            </ScrollView>
        </View>
    );
}
