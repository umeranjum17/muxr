import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { sync } from '@/catalog/sync';
import { Typography } from '@/constants/Typography';

/** Search the host's rendered pane read through the existing encrypted request path. */
export function FindOutputSheet({ sessionId, keyboardOffset, onClose }: { sessionId: string; keyboardOffset: number; onClose: () => void }) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [query, setQuery] = React.useState('');
    const [output, setOutput] = React.useState('');
    const [truncated, setTruncated] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState('');
    const [selected, setSelected] = React.useState(0);
    const requestGeneration = React.useRef(0);
    const load = React.useCallback(() => {
        const generation = ++requestGeneration.current;
        setLoading(true);
        setError('');
        void sync.request('pane.read', { sessionId, source: 'recent', lines: 2000 })
            .then((result) => { if (generation === requestGeneration.current) { setOutput(result.text); setTruncated(result.truncated); setSelected(0); } })
            .catch((reason: unknown) => { if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : 'Could not read output'); })
            .finally(() => { if (generation === requestGeneration.current) setLoading(false); });
    }, [sessionId]);
    React.useEffect(() => { load(); return () => { requestGeneration.current++; }; }, [load]);
    const lines = React.useMemo(() => output.split('\n'), [output]);
    const matches = React.useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        if (needle === '') return [];
        return lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [index] : []);
    }, [lines, query]);
    const current = matches[Math.min(selected, matches.length - 1)];
    // The keyboard leaves room for only a few lines; put the selected hit first.
    const contextStart = current === undefined ? 0 : keyboardOffset > 0 ? current : Math.max(0, current - 3);
    const context = current === undefined ? [] : lines.slice(contextStart, Math.min(lines.length, current + 4));
    const move = (direction: number) => setSelected((value) => (value + direction + matches.length) % matches.length);
    const foreground = theme.colors.text;
    const secondary = theme.colors.textSecondary;
    return <View accessibilityViewIsModal style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: keyboardOffset, zIndex: 50, justifyContent: 'flex-end', backgroundColor: theme.colors.scrim }}>
        <Pressable onPress={onClose} accessibilityLabel="Close Find in output" style={{ flex: 1 }} />
        <View style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: (keyboardOffset > 0 ? 0 : insets.bottom) + 12, maxHeight: '85%' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 8 }}>
                <Text style={{ flex: 1, color: foreground, fontSize: 17, fontWeight: '600' }}>Find in output</Text>
                <Pressable onPress={load} accessibilityRole="button" accessibilityLabel="Refresh output" hitSlop={8}><Ionicons name="refresh" size={21} color={secondary} /></Pressable>
                <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close search" hitSlop={8} style={{ marginLeft: 12 }}><Ionicons name="close" size={23} color={secondary} /></Pressable>
            </View>
            <TextInput value={query} onChangeText={(value) => { setQuery(value); setSelected(0); }} autoFocus autoCorrect={false}
                placeholder="Search terminal output" placeholderTextColor={secondary} accessibilityLabel="Search terminal output"
                style={{ marginHorizontal: 16, borderRadius: 8, padding: 12, color: foreground, backgroundColor: theme.colors.surfaceHigh, fontSize: 16, ...Typography.default() }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={{ flex: 1, color: secondary, fontSize: 14 }}>
                    {loading ? 'Reading output…' : error || (output === '' ? 'No output yet' : query.trim() === '' ? 'Enter a word to find' : matches.length === 0 ? 'No matches' : `${selected + 1} of ${matches.length} matching lines`)}
                </Text>
                {matches.length > 0 && <>
                    <Pressable onPress={() => move(-1)} accessibilityRole="button" accessibilityLabel="Previous match" hitSlop={8}><Ionicons name="chevron-up" size={23} color={foreground} /></Pressable>
                    <Pressable onPress={() => move(1)} accessibilityRole="button" accessibilityLabel="Next match" hitSlop={8}><Ionicons name="chevron-down" size={23} color={foreground} /></Pressable>
                </>}
            </View>
            {loading && <ActivityIndicator style={{ margin: 20 }} color={theme.colors.accent} />}
            {current !== undefined && <ScrollView style={{ maxHeight: 240, marginHorizontal: 16, marginBottom: 8, borderRadius: 8, backgroundColor: theme.colors.surfaceHigh }}>
                {context.map((line, offset) => <Text key={contextStart + offset} selectable style={{ color: contextStart + offset === current ? foreground : secondary, backgroundColor: contextStart + offset === current ? theme.colors.surfaceSelected : 'transparent', fontSize: 12, paddingHorizontal: 10, paddingVertical: 4, ...Typography.mono() }}>
                    {`${contextStart + offset + 1}  ${line}`}
                </Text>)}
            </ScrollView>}
            {truncated && <Text style={{ color: secondary, fontSize: 12, marginHorizontal: 16, marginBottom: 4 }}>Showing the most recent available output</Text>}
        </View>
    </View>;
}
