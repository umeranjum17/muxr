import * as React from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { PierreDiffView } from '@/components/diff/PierreDiffView';

interface PatchFile {
    key: string;
    label: string;
    patch: string;
}

function patchFiles(patch: string): PatchFile[] {
    const starts = [...patch.matchAll(/^diff --git .+$/gm)];
    if (starts.length < 2) return [];
    return starts.map((match, index) => {
        const start = match.index ?? 0;
        const end = starts[index + 1]?.index ?? patch.length;
        const filePatch = patch.slice(start, end).trimEnd();
        const path = /^\+\+\+\s+(?:b\/)?([^\t\n]+)/m.exec(filePatch)?.[1]
            ?? / b\/(.+)$/.exec(match[0])?.[1]
            ?? `File ${index + 1}`;
        const clean = path.replace(/^"|"$/g, '');
        return { key: `${index}:${clean}`, label: clean, patch: filePatch };
    });
}

/** A commit stays scrollable as one patch, but every changed file is one tap away. */
export function NavigableDiff({ patch }: { patch: string }) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const files = React.useMemo(() => patchFiles(patch), [patch]);
    const [selected, setSelected] = React.useState<number>();
    React.useEffect(() => setSelected(undefined), [patch]);
    const shown = selected === undefined ? patch : files[selected]?.patch ?? patch;

    return <View>
        {files.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rail}
            contentContainerStyle={styles.railContent} accessibilityRole="tablist">
            <DiffTab label="All" active={selected === undefined} onPress={() => setSelected(undefined)} />
            {files.map((file, index) => <DiffTab key={file.key} label={file.label.split('/').pop() ?? file.label}
                accessibilityLabel={`Show changes in ${file.label}`} active={selected === index} onPress={() => setSelected(index)} />)}
        </ScrollView>}
        <PierreDiffView patch={shown} diffStyle="unified" overflow={width < 700 ? 'wrap' : 'scroll'} fontSize={12} />
    </View>;

    function DiffTab({ label, active, onPress, accessibilityLabel }: { label: string; active: boolean; onPress: () => void; accessibilityLabel?: string }) {
        return <Pressable onPress={onPress} accessibilityRole="tab" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: active }}
            style={({ pressed }) => [styles.tab, { borderColor: theme.colors.divider, backgroundColor: active ? theme.colors.surfaceHighest : pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }]}>
            <Text numberOfLines={1} style={{ color: active ? theme.colors.text : theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono(active ? 'semiBold' : 'regular') }}>{label}</Text>
        </Pressable>;
    }
}

const styles = StyleSheet.create({
    rail: { marginBottom: 8 },
    railContent: { gap: 6, paddingRight: 16 },
    tab: { minHeight: 44, maxWidth: 180, justifyContent: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11 },
});
