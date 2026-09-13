/**
 * Find in recent output: one host read of the pane's retained scrollback,
 * searched on the phone. The live terminal never moves for it.
 */

import * as React from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, Text, TextInput, View } from 'react-native';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { Typography } from '@/constants/Typography';
import { sync } from '@/catalog/sync';
import { humanError } from '@/utils/errors';

/** What one read may keep: the last lines, within the last bytes. */
const MAX_LINES = 1000;
const MAX_BYTES = 256 * 1024;
/** Matches shown; past this the query is too broad to read anyway. */
const MAX_MATCHES = 200;
const CONTEXT_LINES = 1;

type Snapshot = {
    lines: string[];
    capturedAt: number;
    /** The computer kept older output it did not send. */
    serverTruncated: boolean;
    /** The phone dropped leading lines to stay within its cap. */
    clientTruncated: boolean;
};

/**
 * Keep the last MAX_LINES lines and at most MAX_BYTES of text. A cut that
 * lands mid-line drops that leading fragment rather than show half a line.
 */
export function clipSnapshot(text: string): { lines: string[]; clientTruncated: boolean } {
    let body = text.replace(/\r/g, '');
    let clientTruncated = false;
    const bytes = new TextEncoder().encode(body);
    if (bytes.length > MAX_BYTES) {
        body = new TextDecoder().decode(bytes.slice(bytes.length - MAX_BYTES));
        const firstBreak = body.indexOf('\n');
        body = firstBreak === -1 ? '' : body.slice(firstBreak + 1);
        clientTruncated = true;
    }
    let lines = body.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length > MAX_LINES) {
        lines = lines.slice(lines.length - MAX_LINES);
        clientTruncated = true;
    }
    return { lines, clientTruncated };
}

/** Case-insensitive literal match; each hit with its adjacent lines, merged when they touch. */
export function findMatches(lines: readonly string[], query: string): { index: number; hit: boolean }[][] {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];
    const groups: { index: number; hit: boolean }[][] = [];
    let hits = 0;
    for (let index = 0; index < lines.length && hits < MAX_MATCHES; index++) {
        if (!lines[index]!.toLowerCase().includes(needle)) continue;
        hits++;
        const from = Math.max(0, index - CONTEXT_LINES);
        const to = Math.min(lines.length - 1, index + CONTEXT_LINES);
        const last = groups[groups.length - 1];
        if (last !== undefined && last[last.length - 1]!.index >= from - 1) {
            for (let at = last[last.length - 1]!.index + 1; at <= to; at++) last.push({ index: at, hit: at === index });
            const own = last.find((row) => row.index === index);
            if (own !== undefined) own.hit = true;
            continue;
        }
        const group: { index: number; hit: boolean }[] = [];
        for (let at = from; at <= to; at++) group.push({ index: at, hit: at === index });
        groups.push(group);
    }
    return groups;
}

function timeLabel(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function FindOutputSheet({ visible, sessionId, keyboardPad, onClose }: {
    visible: boolean;
    sessionId: string;
    /** The screen's own keyboard occlusion, so the footer stays above the IME. */
    keyboardPad: number;
    onClose: () => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const [query, setQuery] = React.useState('');
    const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
    const [reading, setReading] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    // One read at a time; a response for a closed sheet or another pane is dropped.
    const generation = React.useRef(0);

    const read = React.useCallback(() => {
        const ticket = ++generation.current;
        setReading(true);
        setFailure(null);
        void sync.request('pane.read', { sessionId, source: 'recent_unwrapped', lines: MAX_LINES, ansi: false })
            .then((result) => {
                if (ticket !== generation.current) return;
                const clipped = clipSnapshot(result.text);
                setSnapshot({ lines: clipped.lines, capturedAt: Date.now(), serverTruncated: result.truncated, clientTruncated: clipped.clientTruncated });
            })
            .catch((error: unknown) => {
                if (ticket !== generation.current) return;
                // An old snapshot stays, labelled with its own time.
                setFailure(humanError(error).message);
            })
            .finally(() => { if (ticket === generation.current) setReading(false); });
    }, [sessionId]);

    // Open: one read. Closed or another pane: forget the snapshot and any
    // answer still in flight.
    React.useEffect(() => {
        if (!visible) {
            generation.current++;
            setSnapshot(null);
            setFailure(null);
            setReading(false);
            setQuery('');
            return;
        }
        read();
        return () => { generation.current++; };
    }, [visible, sessionId, read]);

    const groups = React.useMemo(() => (snapshot === null ? [] : findMatches(snapshot.lines, query)), [snapshot, query]);
    const hits = React.useMemo(() => groups.reduce((count, group) => count + group.filter((row) => row.hit).length, 0), [groups]);
    const trimmed = query.trim();

    let notice: string;
    if (snapshot === null) notice = reading ? 'Reading recent output…' : failure !== null ? `Could not read the output: ${failure}` : '';
    else {
        const parts = [`${snapshot.lines.length.toLocaleString()} ${snapshot.lines.length === 1 ? 'line' : 'lines'} retained`, `captured ${timeLabel(snapshot.capturedAt)}`, 'Older output is not included'];
        if (snapshot.serverTruncated) parts.push('the computer kept more than it sent');
        if (snapshot.clientTruncated) parts.push('the phone kept only the last part');
        if (failure !== null) parts.push(`refresh failed: ${failure}`);
        notice = parts.join(' · ');
    }
    let empty: string | null = null;
    if (snapshot !== null) {
        if (snapshot.lines.length === 0) empty = 'No recent output was retained for this pane';
        else if (trimmed === '') empty = 'Type text to find';
        else if (groups.length === 0) empty = 'No matching text in this snapshot';
    } else if (!reading && failure !== null) empty = 'Nothing to search until the output can be read';

    const mono = Typography.mono('regular');
    // The sheet is over the session: its dark surface, named in this same
    // render that owns the snapshot and query state, so every re-render --
    // a read landing, a keystroke -- re-applies it to the sheet's chrome
    // and rows alike.
    return (
        <ScopedTheme name="dark">
        <OptionSheet
            visible={visible}
            title="Find in recent output"
            options={[]}
            onSelect={() => undefined}
            onClose={onClose}
            virtualizedBody
            virtualizedBodyHeight={4096}
            body={(
                <View style={{ flex: 1 }}>
                    <Text style={{ paddingHorizontal: 20, paddingBottom: 8, fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary }}>{notice}</Text>
                    {empty !== null ? (
                        <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 24 }}>
                            <Text style={{ fontSize: 15, color: theme.colors.textSecondary }}>{empty}</Text>
                        </View>
                    ) : (
                        <FlatList
                            style={{ flex: 1 }}
                            data={groups}
                            keyExtractor={(group) => String(group[0]!.index)}
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="on-drag"
                            initialNumToRender={12}
                            ListHeaderComponent={hits >= MAX_MATCHES
                                ? <Text style={{ paddingHorizontal: 20, paddingBottom: 6, fontSize: 12, color: theme.colors.textSecondary }}>First {MAX_MATCHES} matches shown; narrow the text to see the rest</Text>
                                : null}
                            renderItem={({ item: group }) => (
                                // Rows mount on the list's own scroll passes, outside any
                                // scope above; the surface is named again per row.
                                <ScopedTheme name="dark">
                                    <View style={{ marginHorizontal: 12, marginBottom: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh, paddingVertical: 6 }}>
                                        {group.map((row) => (
                                            <Text key={row.index} selectable style={{ ...mono, fontSize: 12, lineHeight: 17, paddingHorizontal: 12, color: row.hit ? theme.colors.text : theme.colors.textSecondary, backgroundColor: row.hit ? theme.colors.surfaceHighest : 'transparent' }}>
                                                {snapshot!.lines[row.index] === '' ? ' ' : snapshot!.lines[row.index]}
                                            </Text>
                                        ))}
                                    </View>
                                </ScopedTheme>
                            )}
                        />
                    )}
                    {/* The footer is where the thumb is, and stays above the IME:
                        the query, a deliberate Refresh, and Done. Return only
                        drops the keyboard; nothing here reaches the terminal. */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: keyboardPad, borderTopWidth: 1, borderTopColor: theme.colors.divider }}>
                        <TextInput
                            value={query}
                            onChangeText={setQuery}
                            onSubmitEditing={() => Keyboard.dismiss()}
                            placeholder="Text to find"
                            placeholderTextColor={theme.colors.textSecondary}
                            accessibilityLabel="Text to find in recent output"
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="search"
                            blurOnSubmit
                            style={{ flex: 1, minWidth: 0, minHeight: 44, color: theme.colors.text, backgroundColor: theme.colors.surfaceHigh, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
                        />
                        <Pressable onPress={read} disabled={reading} accessibilityRole="button" accessibilityLabel="Refresh the snapshot" accessibilityState={{ disabled: reading, busy: reading }}
                            style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 8, opacity: reading ? 0.5 : pressed ? 0.6 : 1 })}>
                            {reading ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text }}>Refresh</Text>}
                        </Pressable>
                        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Done"
                            style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 8, opacity: pressed ? 0.6 : 1 })}>
                            <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Done</Text>
                        </Pressable>
                    </View>
                </View>
            )}
        />
        </ScopedTheme>
    );
}
