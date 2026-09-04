import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, type ListRenderItemInfo } from 'react-native';
import Animated, { FadeIn, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, type SyntaxSpan } from '@/components/code/syntaxHighlighting';
import {
    columnsFor,
    displayCells,
    expandTabs,
    layoutLines,
    lineHeightFor,
    prefixSums,
    sliceSpans,
} from '@/components/code/codeLayout';
import { codePalette } from '@/components/code/syntaxPalette';
import { withAlpha } from '@/components/ui';
import { buildScopeModel } from '@/components/code/scopeOutline';
import { foldRuns, type InlayRow } from '@/components/diff/inlay';
import { markSpans, wordRanges, type Range } from '@/components/diff/wordDiff';
import { Scrubber, type ScrubTick } from '@/components/document/Scrubber';
import { ScopePin } from '@/components/document/ScopePin';
import type { SurfaceSeparator } from '@/components/document/surfaceModel';

/** The whole ornament budget on a phone: a 3 dp change bar and a marker cell. */
export const LEFT_INSET = 16;
export const CHANGE_BAR = 3;
export const PANEL_RADIUS = 16;
const RIGHT_INSET = 16;
const PILL_HEIGHT = 28;
/** The chip plus the 8 dp of air above and below it. */
const PILL_ROW = PILL_HEIGHT + 16;

/** Opens with a bracket that closes something above it. */
const CLOSER = /^[)\]}]/;

/** Any sliver of a row counts as on screen for the pan measurement. */
const VIEWABILITY = { itemVisiblePercentThreshold: 0 };

/** GitHub Desktop's `MaxIntraLineDiffStringLength`; past this, marks are noise. */
const MAX_WORD_DIFF_CHARS = 1024;

function indentOf(text: string): number {
    let at = 0;
    while (at < text.length && (text.charCodeAt(at) === 32 || text.charCodeAt(at) === 9)) at += 1;
    return at;
}

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
    /** Off by default: a long row keeps its length and the surface pans. */
    wrap: boolean;
    paddingTop: number;
    paddingBottom: number;
    /** Fold untouched runs away; off for a plain file with no patch. */
    foldUnchanged: boolean;
    hunkRows: number[];
    /** Gaps the patch skipped, when there is no content to expand into. */
    separators?: SurfaceSeparator[];
    highlightLine?: number;
    surfaceRef?: React.MutableRefObject<{ jumpToRow: (row: number) => void } | null>;
    /** The 40 dp panel header; it sits inside the panel's top radius. */
    header?: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const { rows, charWidth, fontSize } = props;
    const lineHeight = lineHeightFor(fontSize);
    // Edge to edge. The 12 dp panel inset either side was three columns of
    // code, and width is the one scarce resource on this surface.
    const codeWidth = props.contentWidth - LEFT_INSET - RIGHT_INSET;
    const fitCols = columnsFor(codeWidth, charWidth);
    // Unwrapped, a row keeps its true length and the surface pans sideways.
    // No step on any ladder makes a 120-column line fit a 411 dp phone: that
    // needs 4.9 dp type. Wrapping was never the answer to width, panning is.
    // Display cells, not UTF-16 units: `layoutLine` budgets in cells, so a
    // row of 80 CJK characters is 160 wide. Measuring it as 80 gave the row
    // a column budget half its true extent and it wrapped with wrap off.
    const lengths = React.useMemo(() => {
        const out = new Int32Array(rows.length);
        for (let row = 0; row < rows.length; row += 1) out[row] = displayCells(expandTabs(rows[row]?.text ?? ''));
        return out;
    }, [rows]);
    const longestCols = React.useMemo(() => {
        let most = 0;
        for (let row = 0; row < lengths.length; row += 1) most = Math.max(most, lengths[row]!);
        return most;
    }, [lengths]);
    const [visibleRange, setVisibleRange] = React.useState<[number, number]>([0, 0]);
    const cols = props.wrap ? fitCols : Math.max(fitCols, longestCols);
    const mono = Typography.mono();
    const monoBold = Typography.mono('semiBold');
    const code = theme.colors.code;
    const palette = React.useMemo(() => codePalette(theme), [theme]);

    const texts = React.useMemo(() => rows.map((row) => row.text), [rows]);
    const highlighted = React.useMemo(
        () => highlightCodeLines(texts.join('\n'), props.language),
        [props.language, texts],
    );
    const layouts = React.useMemo(() => layoutLines(texts, cols), [cols, texts]);
    const scope = React.useMemo(() => buildScopeModel(texts, highlighted), [highlighted, texts]);

    // Word-level change ranges, computed once per document.
    //
    // A block is only word-marked when the removed and added runs are the
    // same length. Pairing 3 removed lines against 7 added ones by position
    // invents a correspondence the diff never claimed, and paints confident
    // bands on lines that were not edited but rewritten. GitHub Desktop
    // (`diff-helpers.tsx:242-262`) and GitUp (`GIComputeHighlightRanges`)
    // independently apply the same guard, both to match github.com. Long
    // lines are skipped for the same reason Desktop caps at 1024 chars:
    // past that the marks are noise, and the work is not free.
    const marks = React.useMemo(() => {
        const out: Record<number, Range[]> = {};
        let at = 0;
        while (at < rows.length) {
            if (rows[at]?.prefix !== '-') { at += 1; continue; }
            let removedEnd = at;
            while (removedEnd < rows.length && rows[removedEnd]?.prefix === '-') removedEnd += 1;
            let addedEnd = removedEnd;
            while (addedEnd < rows.length && rows[addedEnd]?.prefix === '+') addedEnd += 1;
            const removed = removedEnd - at;
            const added = addedEnd - removedEnd;
            if (removed === added) {
                for (let index = 0; index < removed; index += 1) {
                    const before = rows[at + index]!;
                    const after = rows[removedEnd + index]!;
                    if (before.text.length > MAX_WORD_DIFF_CHARS || after.text.length > MAX_WORD_DIFF_CHARS) continue;
                    const ranges = wordRanges(before.text, after.text);
                    if (ranges === null) continue;
                    out[at + index] = ranges.removed;
                    out[removedEnd + index] = ranges.added;
                }
            }
            at = Math.max(addedEnd, at + 1);
        }
        return out;
    }, [rows]);

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

    // The pan reaches the longest line you have actually seen, and never
    // retreats. Sizing it to the whole document lets one 400-character line
    // drag nine hundred short rows into an empty column; sizing it to the
    // visible rows alone makes the scrollable width shrink under a reader
    // who is scrolling, which clamps their horizontal offset sideways. A
    // high-water mark has neither failure: it starts honest and only ever
    // grows, so the coordinate system is stable for the life of the file.
    const seenCols = React.useRef(0);
    const visibleCols = React.useMemo(() => {
        let most = 0;
        const last = Math.min(visibleRange[1], items.length - 1);
        for (let index = Math.max(0, visibleRange[0]); index <= last; index += 1) {
            const item = items[index];
            if (item?.kind !== 'row') continue;
            most = Math.max(most, lengths[item.row] ?? 0);
        }
        seenCols.current = Math.max(seenCols.current, most);
        return seenCols.current;
    }, [items, lengths, visibleRange]);
    React.useEffect(() => { seenCols.current = 0; }, [rows]);
    const panWidth = props.wrap
        ? props.contentWidth
        : Math.max(props.contentWidth, LEFT_INSET + visibleCols * charWidth + RIGHT_INSET);
    const panX = useSharedValue(0);
    const onPanScroll = useAnimatedScrollHandler((event) => { panX.value = event.contentOffset.x; });
    const panMax = Math.max(0, panWidth - props.contentWidth);
    const fadeStyle = useAnimatedStyle(() => ({
        opacity: Math.min(1, Math.max(0, (panMax - panX.value) / 24)),
    }));
    const panRef = React.useRef<ScrollView | null>(null);
    // A ladder step changes every column's width, so an offset measured in
    // the old size points nowhere. Go back to the left edge rather than
    // leave the reader stranded mid-line at a size they did not choose.
    React.useEffect(() => { panRef.current?.scrollTo({ x: 0, animated: false }); }, [charWidth, fontSize]);
    const onViewableItemsChanged = React.useRef((info: { viewableItems: Array<{ index: number | null }> }) => {
        const shown = info.viewableItems.map((entry) => entry.index).filter((index): index is number => index !== null);
        if (shown.length === 0) return;
        setVisibleRange([Math.min(...shown), Math.max(...shown)]);
    }).current;

    const heights = React.useMemo(
        () => items.map((item) => item.kind === 'row' ? (layouts[item.row]?.starts.length ?? 1) * lineHeight : PILL_ROW),
        [items, layouts, lineHeight],
    );
    const offsets = React.useMemo(() => prefixSums(heights), [heights]);
    const contentHeight = offsets[offsets.length - 1] ?? 0;

    // `fraction * rows.length` invented a number: it ignored fold pills, gap
    // chips, wrapped rows of unequal height, and the fact that a patch's
    // rows carry their own source line numbers.
    //
    // The input is the list scroll offset the scrub is about to land on, not
    // a fraction of the content: only `contentHeight - viewportHeight` is
    // scrollable, so a content fraction named rows the list never reaches.
    // `offsets` are measured from the first item, while the list starts that
    // item `paddingTop` below its own origin, so that has to come off before
    // the search.
    const lineLabelAt = React.useCallback((scrollOffset: number) => {
        const target = Math.max(0, scrollOffset - props.paddingTop);
        let low = 0;
        let high = offsets.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if ((offsets[mid] ?? 0) <= target) low = mid; else high = mid - 1;
        }
        for (let index = low; index >= 0; index -= 1) {
            const item = items[index];
            if (item?.kind !== 'row') continue;
            const model = rows[item.row];
            const line = model?.newLine ?? model?.oldLine;
            return line === undefined ? '' : `L ${line}`;
        }
        return '';
    }, [items, offsets, props.paddingTop, rows]);

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

    // The outermost non-blank ancestor of each row, by indentation alone.
    //
    // The token-based opener list is far too sparse to pin against: on this
    // file it finds 14 scopes in 735 lines and leaves the body of most
    // functions with no ancestor at all. Indentation always has an answer,
    // which is the fallback VS Code drops to when no symbol provider
    // answers, and it needs no grammar.
    const pin = React.useMemo(() => {
        const labels: string[] = [];
        const tones: Array<'scope' | 'added' | 'removed'> = [];
        const ofRow = new Map<number, number>();
        const outermost = new Int32Array(rows.length).fill(-1);
        const stack: number[] = [];
        for (let row = 0; row < rows.length; row += 1) {
            const text = rows[row]?.text ?? '';
            if (text.trim() === '') { outermost[row] = stack[0] ?? -1; continue; }
            const indent = indentOf(text);
            while (stack.length > 0 && (indentOf(rows[stack[stack.length - 1]!]?.text ?? '') >= indent)) stack.pop();
            outermost[row] = stack[0] ?? -1;
            stack.push(row);
        }
        // A multi-line signature's closer (`}) {`) sits at the same indent as
        // the line that opened it, so the raw ancestor of a body row reads
        // `}) {`. Walk back over closers to the line a reader would name.
        const labelFor = (row: number): string => {
            let at = row;
            const indent = indentOf(rows[at]?.text ?? '');
            while (at > 0 && CLOSER.test((rows[at]?.text ?? '').trim())) {
                let back = at - 1;
                while (back > 0 && (indentOf(rows[back]?.text ?? '') > indent || (rows[back]?.text ?? '').trim() === '')) back -= 1;
                if (back === at) break;
                at = back;
            }
            return (rows[at]?.text ?? '').trim();
        };
        const labelOfItem = items.map((item) => {
            if (item.kind !== 'row') return -1;
            const ancestor = outermost[item.row] ?? -1;
            if (ancestor < 0) return -1;
            const known = ofRow.get(ancestor);
            if (known !== undefined) return known;
            const text = labelFor(ancestor);
            if (text === '') return -1;
            const prefix = rows[ancestor]?.prefix;
            labels.push(text.length > 72 ? `${text.slice(0, 71)}…` : text);
            tones.push(prefix === '+' ? 'added' : prefix === '-' ? 'removed' : 'scope');
            ofRow.set(ancestor, labels.length - 1);
            return labels.length - 1;
        });
        return { labels, tones, labelOfItem };
    }, [items, rows]);

    const renderRow = (row: number) => {
        const layout = layouts[row]!;
        const model = rows[row]!;
        const added = model.prefix === '+';
        const removed = model.prefix === '-';
        const base = highlighted[row] ?? [{ text: model.text }];
        const ranges = marks[row];
        const visual = sliceSpans(ranges === undefined ? base : markSpans(base, ranges), layout.starts);
        const mark = added ? code.addedWord : code.removedWord;
        return (
            <Animated.View
                {...(expanded[row] === true ? { entering: FadeIn.duration(160) } : {})}
                style={{
                    flexDirection: 'row',
                    // Wrapped, panWidth is the slot width, so this is the same
                    // row. Unwrapped it is the longest line, so the tint and
                    // the change bar run the full length of the content.
                    width: panWidth,
                    backgroundColor: added ? code.addedBg : removed ? code.removedBg : 'transparent',
                }}
            >
                <View style={{ width: LEFT_INSET, alignItems: 'center' }}>
                    <View style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: CHANGE_BAR,
                        backgroundColor: added ? code.addedMark : removed ? code.removedMark : 'transparent',
                    }} />
                    {(added || removed) && (
                        <Text style={{ ...monoBold, marginLeft: CHANGE_BAR, fontSize, lineHeight, color: added ? code.addedMark : code.removedMark }}>
                            {added ? '+' : '−'}
                        </Text>
                    )}
                </View>
                <View style={{ width: panWidth - LEFT_INSET, paddingRight: RIGHT_INSET }}>
                    {visual.map((spans, visualRow) => (
                        <Text
                            key={visualRow}
                            selectable
                            numberOfLines={1}
                            ellipsizeMode="clip"
                            style={{ ...mono, fontSize, lineHeight, color: code.text, paddingLeft: visualRow === 0 ? 0 : layout.hang * charWidth }}
                        >
                            {/* No continuation glyph: a column of arrows down
                                the left of every wrapped line reads as a
                                rendering fault. The hanging indent above is
                                the whole signal, which is what an editor's
                                soft wrap looks like. Syntax colour survives
                                the tint - a changed line is the one you most
                                need to read. */}
                            {spans.length === 0 ? ' ' : <SyntaxSpans spans={spans} palette={palette} markColor={mark} selectable />}
                        </Text>
                    ))}
                </View>
            </Animated.View>
        );
    };

    const chip = (label: string) => (
        <View style={{
            paddingHorizontal: 12,
            height: 28,
            borderRadius: 14,
            justifyContent: 'center',
            backgroundColor: code.surfaceRaised,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: code.hairline,
        }}>
            <Text style={{ ...mono, fontSize: 11.5, color: code.dim }}>{label}</Text>
        </View>
    );

    const renderPill = (start: number, end: number) => (
        <Pressable
            onPress={() => setExpanded((current) => ({ ...current, [start]: true }))}
            accessibilityRole="button"
            accessibilityLabel={`Show ${end - start} unchanged lines`}
            style={({ pressed }) => ({
                height: PILL_ROW,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
            })}
        >
            {chip(`⋯ ${end - start} lines`)}
        </Pressable>
    );

    // Patch-only mode has nothing to expand into, so the same chip says how
    // much the patch skipped without pretending to be a control.
    const renderGap = (lines: number) => (
        <View style={{ height: PILL_ROW, alignItems: 'center', justifyContent: 'center', opacity: 0.6 }}>
            {chip(`⋯ ${lines} ${lines === 1 ? 'line' : 'lines'}`)}
        </View>
    );

    return (
        <View style={{
            flex: 1,
            borderTopLeftRadius: PANEL_RADIUS,
            borderTopRightRadius: PANEL_RADIUS,
            overflow: 'hidden',
            backgroundColor: code.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderBottomWidth: 0,
            borderColor: code.hairline,
            // The page is light behind a dark panel, so the panel needs to
            // lift off it. In dark mode the tone step already does that.
            ...(theme.dark ? {} : {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.12,
                shadowRadius: 8,
                elevation: 3,
            }),
        }}>
            {props.header}
            <View style={{ flex: 1 }} onLayout={(event) => setViewport(event.nativeEvent.layout.height)}>
                {/* Unwrapped, the list is as wide as the longest line and the
                    reader drags sideways, which is what a horizontal drag
                    already means one pane over in the terminal. The pin and
                    the scrubber stay outside this scroller so they hold
                    still while the code moves under them. */}
                <Animated.ScrollView
                    ref={panRef}
                    onScroll={onPanScroll}
                    scrollEventThrottle={16}
                    horizontal
                    scrollEnabled={!props.wrap && panWidth > props.contentWidth}
                    showsHorizontalScrollIndicator={!props.wrap}
                    contentContainerStyle={{ width: panWidth, flexGrow: 1 }}
                    style={{ flex: 1 }}
                >
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
                        onViewableItemsChanged={onViewableItemsChanged}
                        viewabilityConfig={VIEWABILITY}
                        showsVerticalScrollIndicator={false}
                        contentContainerStyle={{ paddingTop: props.paddingTop, paddingBottom: props.paddingBottom }}
                        style={{ flex: 1, width: panWidth }}
                    />
                </Animated.ScrollView>
                {/* A transient scroll indicator only appears once you have
                    already panned, so it cannot be what tells you panning
                    exists. This fade is on screen whenever there is code to
                    the right, and retires when you reach the end. */}
                {!props.wrap && panWidth > props.contentWidth && (
                    <Animated.View pointerEvents="none" style={[{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 18, flexDirection: 'row' }, fadeStyle]}>
                        {[0.15, 0.35, 0.6, 0.85].map((alpha, index) => (
                            <View key={index} style={{ flex: 1, backgroundColor: withAlpha(code.surface, alpha) }} />
                        ))}
                    </Animated.View>
                )}
                {pin.labels.length > 0 && (
                    <ScopePin
                        scrollY={scrollY}
                        offsets={offsets}
                        labelOfItem={pin.labelOfItem}
                        labels={pin.labels}
                        tones={pin.tones}
                    />
                )}
                {viewport > 0 && contentHeight > viewport * 1.5 && (
                    <Scrubber
                        listRef={listRef}
                        scrollY={scrollY}
                        height={viewport}
                        contentHeight={contentHeight}
                        viewportHeight={viewport}
                        ticks={ticks}
                        offsets={offsets}
                        labelFor={lineLabelAt}
                    />
                )}
            </View>
        </View>
    );
}
