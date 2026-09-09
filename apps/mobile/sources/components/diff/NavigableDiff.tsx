import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { PierreDiffView, type DiffListRef } from '@/components/diff/PierreDiffView';
import type { CodeContentPadding } from '@/components/code/CodeCore';
import { patchFiles, uniqueDiffLabels, type PatchFile } from '@/components/diff/patchFiles';
import { PatchSurface } from '@/components/diff/PatchSurface';
/** A commit stays scrollable as one patch, but every changed file is one tap away. */
export function NavigableDiff({
    patch,
    fontSize,
    onHunkIndices,
    onFileCount,
    disableFileHeader,
    diffStyle,
    contentWidth,
    contentPadding,
    listRef,
    onDerivedFontSize,
    railNative,
}: {
    patch: string;
    fontSize?: number;
    onHunkIndices?: (indices: number[]) => void;
    onFileCount?: (count: number) => void;
    disableFileHeader?: boolean;
    diffStyle?: 'unified' | 'split';
    contentWidth?: number;
    contentPadding?: CodeContentPadding;
    listRef?: DiffListRef;
    onDerivedFontSize?: (size: number) => void;
    railNative?: NativeGesture;
}) {
    const { theme } = useUnistyles();
    const files = React.useMemo(() => patchFiles(patch), [patch]);
    const [selected, setSelected] = React.useState<number>();
    React.useEffect(() => setSelected(undefined), [patch]);
    React.useEffect(() => { onFileCount?.(files.length); }, [files.length, onFileCount]);
    const shown = selected === undefined ? patch : files[selected]?.patch ?? patch;
    const chipLabels = React.useMemo(() => uniqueDiffLabels(files.map((file) => file.label)), [files]);

    // The rail rides the list so the diff itself owns the only scroller.
    const railGesture = React.useMemo(() => railNative ?? Gesture.Native(), [railNative]);
    const rail = files.length > 1
        ? <GestureDetector gesture={railGesture}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rail}
                contentContainerStyle={styles.railContent} accessibilityRole="tablist">
                <DiffTab label="All" active={selected === undefined} onPress={() => setSelected(undefined)} />
                {files.map((file, index) => (
                    <DiffTab key={file.key} file={file} label={chipLabels[index] ?? file.label} active={selected === index} onPress={() => setSelected(index)} />
                ))}
            </ScrollView>
        </GestureDetector>
        : undefined;

    // Native reads every patch on the shared surface; the Pierre renderer is
    // the web path only.
    if (Platform.OS !== 'web') {
        return (
            <View style={{ flex: 1 }}>
                {rail}
                <PatchSurface
                    patch={shown}
                    {...(contentWidth === undefined ? {} : { contentWidth })}
                    {...(fontSize === undefined ? {} : { fontSize })}
                    {...(contentPadding === undefined ? {} : { contentPadding })}
                    {...(onHunkIndices === undefined ? {} : { onHunkIndices })}
                />
            </View>
        );
    }

    return <PierreDiffView
        patch={shown}
        diffStyle={diffStyle ?? 'unified'}
        {...(fontSize === undefined ? {} : { fontSize })}
        {...(contentWidth === undefined ? {} : { contentWidth })}
        {...(contentPadding === undefined ? {} : { contentPadding })}
        {...(listRef === undefined ? {} : { listRef })}
        {...(rail === undefined ? {} : { listHeader: rail })}
        {...(onHunkIndices === undefined ? {} : { onHunkIndices })}
        {...(onDerivedFontSize === undefined ? {} : { onDerivedFontSize })}
        {...(disableFileHeader === true ? { disableFileHeader: true } : {})}
    />;

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
    rail: { height: 52, marginBottom: 8 },
    railContent: { gap: 6, paddingRight: 16 },
    tab: { minHeight: 44, maxWidth: 190, justifyContent: 'center', gap: 2, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11 },
    tabTitle: { flexDirection: 'row', alignItems: 'center', gap: 5 },
});
