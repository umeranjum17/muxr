import * as React from 'react';
import { Platform, Pressable, Text, View, type ListRenderItemInfo } from 'react-native';
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, type SyntaxSpan } from '@/components/code/syntaxHighlighting';
import {
    columnsFor,
    layoutLines,
    lineHeightFor,
    prefixSums,
    sliceSpans,
} from '@/components/code/codeLayout';
import { codePalette } from '@/components/code/syntaxPalette';
import { withAlpha } from '@/components/ui';
import { buildScopeModel } from '@/components/code/scopeOutline';
import { foldRuns, type InlayRow } from '@/components/diff/inlay';
import { Scrubber, type ScrubTick } from '@/components/document/Scrubber';
import type { SurfaceSeparator } from '@/components/document/surfaceModel';

/** The whole ornament budget on a phone: a 3 dp change bar and a marker cell. */
export const LEFT_INSET = 16;
export const CHANGE_BAR = 3;
export const PANEL_RADIUS = 16;
const RIGHT_INSET = 16;
const PILL_HEIGHT = 28;

type SurfaceItem =
    | { kind: 'row'; row: number }
    | { kind: 'pill'; start: number; end: number }
    | { kind: 'gap'; row: number; lines: number };

/**
 * One edge-to-edge column of code.
 *
 * There is no number gutter and no card. tig documents that wrapping and line
 * numbers cannot share a narrow width, and OpenHub drops the numbers when it
 * wraps; both are right. The 55 dp those columns cost is 8 columns of code,
 * and the number is recoverable from the pin, the scrub label and a tap.
 */
export function CodeSurface(props: {
    rows: InlayRow[];
    language?: string;
    contentWidth: number;
    charWidth: number;
    fontSize: number;
    isNarrow: boolean;
    paddingTop: number;
    paddingBottom: number;
    /** Fold untouched runs away; off for a plain file with no patch. */
    foldUnchanged: boolean;
    hunkRows: number[];
    /** Gaps the patch skipped, when there is no content to expand into. */
    separators?: SurfaceSeparator[];
    highlightLine?: number;
    surfaceRef?: React.MutableRefObject<{ jumpToRow: (row: number) => void } | null>;
}) {
    const { theme } = useUnistyles();
    const { rows, charWidth, fontSize } = props;
    const lineHeight = lineHeightFor(fontSize);
    const codeWidth = props.contentWidth - LEFT_INSET - RIGHT_INSET;
    const cols = columnsFor(codeWidth, charWidth);
    const mono = Typography.mono();

    const texts = React.useMemo(() => rows.map((row) => row.text), [rows]);
    const highlighted = React.useMemo(
        () => highlightCodeLines(texts.join('\n'), props.language),
        [props.language, texts],
    );
    const layouts = React.useMemo(() => layoutLines(texts, cols), [cols, texts]);
    const scope = React.useMemo(() => buildScopeModel(texts, highlighted), [highlighted, texts]);

    const [expanded, setExpanded] = React.useState<Record<number, true>>({});
    React.useEffect(() => setExpanded({}), [rows]);
    const folds = React.useMemo(
        () => props.foldUnchanged ? foldRuns(rows).filter((run) => expanded[run.start] !== true) : [],
        [expanded, props.foldUnchanged, rows],
    );

    // One list of items: every visible row, with a pill standing in for each
    // folded run. Built once per fold change, never per frame.
    const items = React.useMemo(() => {
        const out: SurfaceItem[] = [];
        let fold = 0;
        const gapAt = new Map((props.separators ?? []).map((gap) => [gap.row, gap.lines]));
        for (let row = 0; row < rows.length; row += 1) {
            const gap = gapAt.get(row);
            if (gap !== undefined) out.push({ kind: 'gap', row, lines: gap });
            const run = folds[fold];
            if (run !== undefined && row === run.start) {
                out.push({ kind: 'pill', start: run.start, end: run.end });
                row = run.end - 1;
                fold += 1;
                continue;
            }
            out.push({ kind: 'row', row });
        }
        return out;
    }, [folds, props.separators, rows.length]);

    const heights = React.useMemo(
        () => items.map((item) => item.kind === 'row' ? (layouts[item.row]?.starts.length ?? 1) * lineHeight : PILL_HEIGHT),
        [items, layouts, lineHeight],
    );
    const offsets = React.useMemo(() => prefixSums(heights), [heights]);
    const contentHeight = offsets[offsets.length - 1] ?? 0;

    // Row index → item index, so a jump target survives folding.
    const itemOfRow = React.useMemo(() => {
        const map = new Int32Array(rows.length).fill(-1);
        items.forEach((item, index) => { if (item.kind === 'row') map[item.row] = index; });
        return map;
    }, [items, rows.length]);

    const listRef = useAnimatedRef<Animated.FlatList<never>>();
    const scrollY = useSharedValue(0);
    const onScroll = useAnimatedScrollHandler((event) => { scrollY.value = event.contentOffset.y; });
    const [viewport, setViewport] = React.useState(0);

    const jumpToRow = React.useCallback((row: number) => {
        const index = itemOfRow[Math.max(0, Math.min(rows.length - 1, row))] ?? 0;
        if (index >= 0) (listRef.current as never as { scrollToIndex: (o: object) => void } | null)?.scrollToIndex({ index, viewOffset: 2 * lineHeight + 8, animated: true });
    }, [itemOfRow, lineHeight, listRef, rows.length]);
    if (props.surfaceRef !== undefined) props.surfaceRef.current = { jumpToRow };

    const ticks: ScrubTick[] = React.useMemo(() => {
        const total = Math.max(1, contentHeight);
        const out: ScrubTick[] = [];
        for (const hunk of props.hunkRows) {
            const index = itemOfRow[hunk] ?? -1;
            if (index < 0) continue;
            const added = rows[hunk]?.prefix === '+';
            out.push({ at: (offsets[index] ?? 0) / total, tone: added ? 'added' : 'removed', row: hunk, label: `L ${rows[hunk]?.newLine ?? rows[hunk]?.oldLine ?? hunk + 1}` });
        }
        if (out.length === 0) {
            for (const opener of scope.openers) {
                if ((scope.indents[opener] ?? 0) > 0) continue;
                const index = itemOfRow[opener] ?? -1;
                if (index < 0) continue;
                out.push({ at: (offsets[index] ?? 0) / total, tone: 'scope', row: opener, label: `L ${opener + 1}` });
            }
        }
        return out.slice(0, 60);
    }, [contentHeight, itemOfRow, offsets, props.hunkRows, rows, scope]);

    const renderRow = (row: number) => {
        const layout = layouts[row]!;
        const model = rows[row]!;
        const added = model.prefix === '+';
        const removed = model.prefix === '-';
        const visual = sliceSpans(highlighted[row] ?? [{ text: model.text }], layout.starts);
        const foreground = added ? theme.colors.diff.addedText : removed ? theme.colors.diff.removedText : theme.colors.syntaxDefault;
        return (
            <View style={{
                flexDirection: 'row',
                backgroundColor: added
                    ? withAlpha(theme.colors.diff.success, 0.10)
                    : removed ? withAlpha(theme.colors.diff.error, 0.10) : 'transparent',
            }}>
                <View style={{ width: LEFT_INSET, alignItems: 'center' }}>
                    <View style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: CHANGE_BAR,
                        backgroundColor: added ? theme.colors.diff.success : removed ? theme.colors.diff.error : 'transparent',
                    }} />
                    {(added || removed) && (
                        <Text style={{ ...mono, marginLeft: CHANGE_BAR, fontSize, lineHeight, color: added ? theme.colors.diff.success : theme.colors.diff.error }}>
                            {model.prefix}
                        </Text>
                    )}
                </View>
                <View style={{ flex: 1, paddingRight: RIGHT_INSET }}>
                    {visual.map((spans, visualRow) => (
                        <Text
                            key={visualRow}
                            selectable
                            numberOfLines={1}
                            ellipsizeMode="clip"
                            style={{ ...mono, fontSize, lineHeight, color: foreground, paddingLeft: visualRow === 0 ? 0 : layout.hang * charWidth }}
                        >
                            {/* No continuation glyph: a column of arrows down
                                the left of every wrapped line reads as a
                                rendering fault. The hanging indent above is
                                the whole signal, which is what an editor's
                                soft wrap looks like. */}
                            {spans.length === 0 ? ' ' : <SyntaxSpans spans={spans} palette={codePalette(theme)} selectable />}
                        </Text>
                    ))}
                </View>
            </View>
        );
    };

    const renderPill = (start: number, end: number) => (
        <Pressable
            onPress={() => setExpanded((current) => ({ ...current, [start]: true }))}
            accessibilityRole="button"
            accessibilityLabel={`Show ${end - start} unchanged lines`}
            style={{ height: PILL_HEIGHT, alignItems: 'center', justifyContent: 'center' }}
        >
            <View style={{
                paddingHorizontal: 12,
                height: 22,
                borderRadius: 11,
                justifyContent: 'center',
                backgroundColor: theme.colors.surfaceHigh,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.divider,
            }}>
                <Text style={{ ...mono, fontSize: 10.5, color: theme.colors.textSecondary }}>{`⋯ ${end - start} unchanged lines`}</Text>
            </View>
        </Pressable>
    );

    // Patch-only mode has nothing to expand into, so this is a rule that says
    // how much the patch skipped, not a control that lies about being one.
    const renderGap = (lines: number) => (
        <View style={{ height: PILL_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: LEFT_INSET, gap: 8, opacity: 0.6 }}>
            <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }} />
            <Text style={{ ...mono, fontSize: 10.5, color: theme.colors.textSecondary }}>
                {`⋯ ${lines} ${lines === 1 ? 'line' : 'lines'}`}
            </Text>
            <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }} />
        </View>
    );

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }} onLayout={(event) => setViewport(event.nativeEvent.layout.height)}>
            <Animated.FlatList
                ref={listRef}
                data={items as never[]}
                extraData={layouts}
                keyExtractor={(_: unknown, index: number) => String(index)}
                renderItem={({ index }: ListRenderItemInfo<unknown>) => {
                    const item = items[index]!;
                    if (item.kind === 'pill') return renderPill(item.start, item.end);
                    if (item.kind === 'gap') return renderGap(item.lines);
                    return renderRow(item.row);
                }}
                getItemLayout={(_: unknown, index: number) => ({ length: heights[index] ?? lineHeight, offset: offsets[index] ?? 0, index })}
                initialNumToRender={40}
                maxToRenderPerBatch={24}
                windowSize={7}
                removeClippedSubviews={Platform.OS === 'android'}
                onScroll={onScroll}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingTop: props.paddingTop, paddingBottom: props.paddingBottom }}
                style={{ flex: 1 }}
            />
            {viewport > 0 && contentHeight > viewport * 1.5 && (
                <Scrubber
                    listRef={listRef}
                    scrollY={scrollY}
                    height={viewport}
                    contentHeight={contentHeight}
                    viewportHeight={viewport}
                    ticks={ticks}
                    offsets={offsets}
                    labelFor={(fraction) => `L ${Math.round(fraction * rows.length)}`}
                />
            )}
        </View>
    );
}
