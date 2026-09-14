import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { sync } from '@/catalog/sync';
import { useHerdrTree, useSession, useSessionsLoaded, useSocketStatus } from '@/catalog/store';
import { AgentGlyph } from '@/components/AgentGlyph';
import { Typography } from '@/constants/Typography';
import { agentLabels, agentNameLine, herdrPaneForSession, isShellLabels } from '@/herd';

const HISTORY_LINES = 2_000;

type HistoryParams = { id?: string | string[] };

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function lineParts(line: string, query: string): Array<{ text: string; match: boolean }> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return [{ text: line, match: false }];
    const lower = line.toLocaleLowerCase();
    const parts: Array<{ text: string; match: boolean }> = [];
    let cursor = 0;
    while (cursor < line.length) {
        const found = lower.indexOf(needle, cursor);
        if (found < 0) {
            parts.push({ text: line.slice(cursor), match: false });
            break;
        }
        if (found > cursor) parts.push({ text: line.slice(cursor, found), match: false });
        parts.push({ text: line.slice(found, found + needle.length), match: true });
        cursor = found + needle.length;
    }
    return parts.length > 0 ? parts : [{ text: line, match: false }];
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const { id: rawId } = useLocalSearchParams<HistoryParams>();
    const sessionId = firstParam(rawId);
    const session = useSession(sessionId ?? '');
    const { workspaces, loaded: treeLoaded } = useHerdrTree();
    const sessionsLoaded = useSessionsLoaded();
    const { status: socketStatus } = useSocketStatus();
    const pane = sessionId === undefined ? undefined : herdrPaneForSession(workspaces, sessionId);
    const paneId = pane?.paneId ?? session?.metadata?.paneId;
    const identity = sessionId === undefined || paneId === undefined ? null : `${sessionId}\u0000${paneId}`;
    const identityRef = React.useRef(identity);
    identityRef.current = identity;
    const [output, setOutput] = React.useState('');
    const [truncated, setTruncated] = React.useState(false);
    const [loadedIdentity, setLoadedIdentity] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [selectedMatch, setSelectedMatch] = React.useState(0);
    const requestGeneration = React.useRef(0);
    const listRef = React.useRef<FlatList<string>>(null);

    const load = React.useCallback(() => {
        if (sessionId === undefined || identity === null) return;
        const expectedIdentity = identity;
        const generation = ++requestGeneration.current;
        setLoading(true);
        setError(false);
        setOutput('');
        setTruncated(false);
        setLoadedIdentity(null);
        void sync.request('pane.read', { sessionId, source: 'recent', lines: HISTORY_LINES, ansi: false })
            .then((result) => {
                if (generation !== requestGeneration.current || identityRef.current !== expectedIdentity) return;
                setOutput(result.text);
                setTruncated(result.truncated);
                setSelectedMatch(0);
                setLoadedIdentity(expectedIdentity);
            })
            .catch(() => {
                if (generation === requestGeneration.current && identityRef.current === expectedIdentity) {
                    setError(true);
                    setLoadedIdentity(null);
                }
            })
            .finally(() => {
                if (generation === requestGeneration.current && identityRef.current === expectedIdentity) setLoading(false);
            });
    }, [identity, sessionId]);

    useFocusEffect(React.useCallback(() => {
        if (identity === null || sessionId === undefined) return undefined;
        load();
        return () => { requestGeneration.current += 1; };
    }, [identity, load, sessionId]));

    const visibleOutput = loadedIdentity === identity ? output : '';
    const lines = React.useMemo(() => visibleOutput === '' ? [] : visibleOutput.split('\n'), [visibleOutput]);
    const needle = query.trim().toLocaleLowerCase();
    const matches = React.useMemo(() => needle === ''
        ? []
        : lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [index] : []), [lines, needle]);
    const currentMatch = matches.length === 0 ? -1 : Math.min(selectedMatch, matches.length - 1);
    const currentLine = currentMatch < 0 ? -1 : matches[currentMatch]!;

    React.useEffect(() => {
        if (currentLine < 0) return;
        requestAnimationFrame(() => {
            listRef.current?.scrollToIndex({ index: currentLine, viewPosition: 0.35, animated: true });
        });
    }, [currentLine]);

    const labels = agentLabels(pane);
    const glyphName = pane?.agentKind ?? (isShellLabels(labels) ? 'shell' : labels.agentName);
    const offline = socketStatus === 'disconnected' || socketStatus === 'error';
    const targetMissing = sessionId === undefined || paneId === undefined;
    const targetLoading = targetMissing && sessionId !== undefined && (!treeLoaded || !sessionsLoaded || session === null);
    const statusText = loading
        ? visibleOutput === '' ? 'Loading pane history…' : 'Refreshing pane history…'
        : error
            ? offline ? 'History is unavailable while muxr is offline.' : 'Could not load pane history.'
            : visibleOutput === ''
                ? 'No history available yet.'
                : needle === ''
                    ? `${lines.length.toLocaleString()} lines · most recent available scrollback`
                    : matches.length === 0
                        ? 'No matching lines'
                        : `${currentMatch + 1} of ${matches.length} matching lines`;

    const moveMatch = (direction: number) => {
        if (matches.length === 0) return;
        setSelectedMatch((value) => (value + direction + matches.length) % matches.length);
    };

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.terminal.background }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surface }}>
                <AgentGlyph name={glyphName} size={24} />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '600' }}>{labels.taskTitle}</Text>
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{agentNameLine(labels)} · pane scrollback</Text>
                </View>
                <Pressable onPress={load} disabled={loading || targetMissing} accessibilityRole="button" accessibilityLabel="Refresh conversation history" accessibilityState={{ disabled: loading || targetMissing }} hitSlop={8} style={{ padding: 6, opacity: loading || targetMissing ? 0.45 : 1 }}>
                    <Ionicons name="refresh" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14 }}>
                <Ionicons name="search-outline" size={18} color={theme.colors.textSecondary} />
                <TextInput
                    value={query}
                    onChangeText={(value) => { setQuery(value); setSelectedMatch(0); }}
                    placeholder="Search history"
                    placeholderTextColor={theme.colors.textSecondary}
                    autoCorrect={false}
                    accessibilityLabel="Search conversation history"
                    selectionColor={theme.colors.accent}
                    style={{ flex: 1, color: theme.colors.text, backgroundColor: theme.colors.surfaceHigh, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, ...Typography.default() }}
                />
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingHorizontal: 16 }}>
                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 12 }}>{statusText}</Text>
                {matches.length > 0 && <>
                    <Pressable onPress={() => moveMatch(-1)} accessibilityRole="button" accessibilityLabel="Previous history match" hitSlop={8}><Ionicons name="chevron-up" size={21} color={theme.colors.text} /></Pressable>
                    <Pressable onPress={() => moveMatch(1)} accessibilityRole="button" accessibilityLabel="Next history match" hitSlop={8}><Ionicons name="chevron-down" size={21} color={theme.colors.text} /></Pressable>
                </>}
            </View>

            {targetMissing ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10 }}>
                    <Ionicons name={targetLoading ? 'locate-outline' : 'alert-circle-outline'} size={34} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>{targetLoading ? 'Locating pane…' : 'Pane is no longer available'}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>{targetLoading ? 'Waiting for the host to publish the current pane.' : 'Go back to the live pane and choose history again.'}</Text>
                    {!targetLoading && <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back to live pane" style={{ marginTop: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.colors.surfaceHigh }}><Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '600' }}>Back to live pane</Text></Pressable>}
                </View>
            ) : error ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10 }}>
                    <Ionicons name={offline ? 'cloud-offline-outline' : 'alert-circle-outline'} size={34} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>{offline ? 'Host connection unavailable' : 'History could not be loaded'}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>{statusText}</Text>
                    <Pressable onPress={load} accessibilityRole="button" accessibilityLabel="Retry loading conversation history" style={{ marginTop: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.colors.surfaceHigh }}><Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '600' }}>Try again</Text></Pressable>
                </View>
            ) : loading && visibleOutput === '' ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                    <ActivityIndicator color={theme.colors.accent} />
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Loading pane history…</Text>
                </View>
            ) : lines.length === 0 ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10 }}>
                    <Ionicons name="document-text-outline" size={34} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>No history available yet</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>The host has not reported any pane scrollback.</Text>
                </View>
            ) : (
                <FlatList
                    ref={listRef}
                    data={lines}
                    keyExtractor={(_line, index) => String(index)}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator
                    contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24 }}
                    onScrollToIndexFailed={(info) => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })}
                    renderItem={({ item, index }) => {
                        const active = index === currentLine;
                        return <Text selectable style={{ color: active ? theme.colors.text : theme.colors.textSecondary, backgroundColor: active ? theme.colors.surfaceSelected : 'transparent', paddingHorizontal: 7, paddingVertical: 3, fontSize: 12, lineHeight: 19, ...Typography.mono() }}>
                            <Text style={{ color: theme.colors.textSecondary }}>{`${String(index + 1).padStart(4, ' ')} `}</Text>
                            {lineParts(item, query).map((part, partIndex) => <Text key={`${index}:${partIndex}`} style={part.match ? { color: theme.colors.text, backgroundColor: theme.colors.accent + '55' } : undefined}>{part.text}</Text>)}
                        </Text>;
                    }}
                />
            )}

            {truncated && loadedIdentity === identity && lines.length > 0 && <Text style={{ paddingHorizontal: 16, paddingBottom: 8, color: theme.colors.textSecondary, fontSize: 11 }}>Showing the most recent available scrollback.</Text>}
        </View>
    );
});
