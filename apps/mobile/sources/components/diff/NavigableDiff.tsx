import * as React from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { patchFiles, uniqueDiffLabels, type PatchFile } from '@/components/diff/patchFiles';

/** A commit stays scrollable as one patch, but every changed file is one tap away. */
export function NavigableDiff({ patch }: { patch: string }) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const files = React.useMemo(() => patchFiles(patch), [patch]);
    const [selected, setSelected] = React.useState<number>();
    React.useEffect(() => setSelected(undefined), [patch]);
    const shown = selected === undefined ? patch : files[selected]?.patch ?? patch;
    const chipLabels = React.useMemo(() => uniqueDiffLabels(files.map((file) => file.label)), [files]);

    return <View>
        {files.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rail}
            contentContainerStyle={styles.railContent} accessibilityRole="tablist">
            <DiffTab label="All" active={selected === undefined} onPress={() => setSelected(undefined)} />
            {files.map((file, index) => (
                <DiffTab key={file.key} file={file} label={chipLabels[index] ?? file.label} active={selected === index} onPress={() => setSelected(index)} />
            ))}
        </ScrollView>}
        <PierreDiffView patch={shown} diffStyle="unified" overflow={width < 700 ? 'wrap' : 'scroll'} fontSize={12} />
    </View>;

    function DiffTab({ file, label, active, onPress }: { file?: PatchFile; label: string; active: boolean; onPress: () => void }) {
        const stats = file === undefined ? undefined : file.binary ? 'binary' : `+${file.added} −${file.removed}`;
        const status = file === undefined ? undefined : file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M';
        const statusColor = file === undefined ? theme.colors.textSecondary
            : file.status === 'added' ? theme.colors.gitAddedText
                : file.status === 'deleted' ? theme.colors.gitRemovedText
                    : file.status === 'modified' ? theme.colors.accent : theme.colors.textSecondary;
        return <Pressable onPress={onPress} accessibilityRole="tab"
            accessibilityLabel={file === undefined ? label : `Show changes in ${file.label}, ${status}, ${stats ?? ''}`}
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [styles.tab, { borderColor: active ? theme.colors.accent : theme.colors.divider, backgroundColor: active ? theme.colors.surfaceSelected : pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }] }>
            <View style={styles.tabTitle}>
                {status !== undefined && <Text style={{ color: statusColor, fontSize: 11, ...Typography.mono('semiBold') }}>{status}</Text>}
                <Text numberOfLines={1} style={{ color: active ? theme.colors.text : theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono(active ? 'semiBold' : 'regular') }}>{label}</Text>
            </View>
            {file?.binary === true
                ? <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono() }}>binary</Text>
                : file !== undefined && <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ color: theme.colors.gitAddedText, fontSize: 10.5, ...Typography.mono('semiBold') }}>+{file.added}</Text>
                    <Text style={{ color: theme.colors.gitRemovedText, fontSize: 10.5, ...Typography.mono('semiBold') }}>−{file.removed}</Text>
                </View>}
        </Pressable>;
    }
}

const styles = StyleSheet.create({
    rail: { marginBottom: 8 },
    railContent: { gap: 6, paddingRight: 16 },
    tab: { minHeight: 44, maxWidth: 190, justifyContent: 'center', gap: 2, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11 },
    tabTitle: { flexDirection: 'row', alignItems: 'center', gap: 5 },
});
