import * as React from 'react';
import { Platform, Text, View, type ListRenderItemInfo } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, syntaxLanguage } from '@/components/code/syntaxHighlighting';
import {
    CONTINUATION_GLYPH,
    GAP,
    RIGHT_INSET,
    columnsFor,
    deriveFontSize,
    diffGutterWidth,
    layoutLines,
    lineHeightFor,
    prefixSums,
    sliceSpans,
} from '@/components/code/codeLayout';
import { useMonoCharWidth } from '@/components/code/monoMetrics';
import { withAlpha } from '@/components/ui';
import type { CodeContentPadding } from '@/components/code/CodeCore';

export type DiffListRef = React.MutableRefObject<{ scrollToIndex: (options: { index: number; viewOffset?: number; animated?: boolean }) => void } | null>;

export interface PierreDiffViewProps {
    /** Unified diff string. */
    patch: string;
    diffStyle?: 'unified' | 'split';
    disableLineNumbers?: boolean;
    /** List index of each hunk header, for jump controls. Native only. */
    onHunkIndices?: (indices: number[]) => void;
    /** Hide Pierre's built-in file-name/stats header — useful when the surrounding UI already shows one. Web-only. */
    disableFileHeader?: boolean;
    /** Forces a theme override; defaults to the current app theme. */
    theme?: 'dark' | 'light';
    /** Replace Pierre's default header with custom React content. Web-only. */
    renderCustomHeader?: (fileDiff: any) => React.ReactNode;
    /** Allow expanding collapsed unchanged lines. Web-only (Pierre feature). */
    expandUnchanged?: boolean;
    /** Overrides the width-derived size. Native-only. */
    fontSize?: number;
    /** Width available to the body, paddings already subtracted. Native-only. */
    contentWidth?: number;
    contentPadding?: CodeContentPadding;
    listRef?: DiffListRef;
    listHeader?: React.ReactElement;
    onDerivedFontSize?: (size: number) => void;
    /** Internal bounded-render attribution. */
    omittedLines?: number;
    totalLines?: number;
    omittedChars?: number;
}

export const PierreDiffView = React.memo(function PierreDiffView(props: PierreDiffViewProps) {
    const bounded = React.useMemo(() => boundText(props.patch), [props.patch]);
    const boundedProps = { ...props, patch: bounded.text, omittedLines: bounded.omittedLines, totalLines: bounded.totalLines, omittedChars: bounded.omittedChars };
    if (Platform.OS === 'web') {
        return <PierreDiffViewWeb {...boundedProps} />;
    }
    return <PierreDiffViewNative {...boundedProps} />;
});

// ────────────────────────────────────────────────────────────────────────────
// Web module loader. Both @pierre/diffs and @pierre/diffs/react are lazy
// chunks; we resolve them once per app run and memoize the promise so every
// diff mount after the first one gets a cache hit with no extra render cycle.
// ────────────────────────────────────────────────────────────────────────────

type PierreMain = typeof import('@pierre/diffs');
type PierreReact = typeof import('@pierre/diffs/react');
type PierreBundle = { main: PierreMain; react: PierreReact };

let pierreBundlePromise: Promise<PierreBundle> | null = null;

function loadPierre(): Promise<PierreBundle> {
    if (!pierreBundlePromise) {
        pierreBundlePromise = (async () => {
            // Side-effect import registers the <diffs-container> custom element.
            const main = await import('@pierre/diffs');
            const react = await import('@pierre/diffs/react');
            return { main, react };
        })();
    }
    return pierreBundlePromise;
}

/**
 * Fire-and-forget prefetch — call once when entering a screen that will show
 * diffs so the lazy chunks are already in cache by the time they're rendered.
 */
export function prefetchPierreDiff(): void {
    if (Platform.OS !== 'web') return;
    void loadPierre();
}

function usePierreBundle(): PierreBundle | null {
    const [bundle, setBundle] = React.useState<PierreBundle | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        loadPierre().then((b) => { if (!cancelled) setBundle(b); });
        return () => { cancelled = true; };
    }, []);
    return bundle;
}

// ────────────────────────────────────────────────────────────────────────────
// Web rendering.
// ────────────────────────────────────────────────────────────────────────────

const COMPACT_WEB_DIFF_CSS = `
:host {
  --diffs-gap-inline: 6px;
  --diffs-gap-block: 2px;
  --diffs-font-size: 12px;
  --diffs-line-height: 18px;
  border: 1px solid var(--diffs-bg-separator);
  border-radius: 10px;
  overflow: hidden;
  margin-block-end: 8px;
}
[data-diffs-header='default'] {
  min-height: 30px;
  padding-inline: 8px;
  background: var(--diffs-bg-context);
  border-bottom: 1px solid var(--diffs-bg-separator);
}
[data-change-icon] { display: none; }
[data-header-content] {
  gap: 4px;
  font-family: var(--diffs-font-family, var(--diffs-font-fallback));
  font-size: 11px;
}
[data-diffs-header='default'] [data-metadata] { gap: 6px; font-size: 11px; }
[data-separator='line-info'],
[data-separator='line-info-basic'],
[data-separator='metadata'] { height: 22px; margin-block: 0; }
[data-separator-content] { padding-inline: 8px; border-radius: 0 !important; font-size: 11px; }
`;

const PierreDiffViewWeb = React.memo(function PierreDiffViewWeb(props: PierreDiffViewProps) {
    const { theme } = useUnistyles();
    const themeName: 'dark' | 'light' = props.theme ?? (theme.dark ? 'dark' : 'light');
    const diffsTheme = themeName === 'dark' ? 'github-dark-default' : 'github-light-default';
    const bundle = usePierreBundle();

    if (!bundle) return <DiffSkeleton />;

    const options = {
        theme: diffsTheme as any,
        diffStyle: props.diffStyle,
        disableLineNumbers: props.disableLineNumbers,
        disableFileHeader: props.disableFileHeader,
        expandUnchanged: props.expandUnchanged,
        hunkSeparators: 'line-info-basic' as const,
        diffIndicators: 'bars' as const,
        unsafeCSS: COMPACT_WEB_DIFF_CSS,
    };

    return <PatchFilesWeb bundle={bundle} patch={props.patch} options={options} renderCustomHeader={props.renderCustomHeader} omittedLines={props.omittedLines} totalLines={props.totalLines} omittedChars={props.omittedChars} />;
});

function PatchFilesWeb({
    bundle,
    patch,
    options,
    renderCustomHeader,
    omittedLines,
    totalLines,
    omittedChars,
}: {
    bundle: PierreBundle;
    patch: string;
    options: any;
    renderCustomHeader?: (fileDiff: any) => React.ReactNode;
    omittedLines?: number;
    totalLines?: number;
    omittedChars?: number;
}) {
    const files = React.useMemo(() => {
        try {
            const parsed = bundle.main.processPatch(patch);
            return parsed.files ?? [];
        } catch {
            // Pierre only accepts a//b+ path prefixes; a user's git config
            // (diff.mnemonicPrefix, custom srcPrefix/dstPrefix) produces i//w/
            // etc. and processPatch throws. The caller sees no files and falls
            // back to the plain patch view.
            return [];
        }
    }, [bundle, patch]);

    const { FileDiff } = bundle.react;
    if (files.length === 0) {
        return <PlainPatchView patch={patch} disableFileHeader={options?.disableFileHeader === true} omittedLines={omittedLines} totalLines={totalLines} omittedChars={omittedChars} />;
    }
    return (
        <View>
            {files.map((fileDiff, i) => (
                <FileDiff key={i} fileDiff={fileDiff} options={options} renderCustomHeader={renderCustomHeader} />
            ))}
            <DiffTruncation omittedLines={omittedLines} totalLines={totalLines} omittedChars={omittedChars} />
        </View>
    );
}

function DiffSkeleton() {
    const { theme } = useUnistyles();
    return (
        <View
            style={{
                height: 96,
                backgroundColor: theme.colors.surface,
                borderRadius: 6,
                opacity: 0.5,
            }}
        />
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Native: no network dependencies — a raw patch string, colorized by prefix.
// Always unified and always wrapped; `diffStyle` and `overflow` are web-only.
// ────────────────────────────────────────────────────────────────────────────

const PierreDiffViewNative = React.memo(function PierreDiffViewNative(props: PierreDiffViewProps) {
    return (
        <PlainPatchView
            patch={props.patch}
            disableFileHeader={props.disableFileHeader === true}
            omittedLines={props.omittedLines}
            totalLines={props.totalLines}
            omittedChars={props.omittedChars}
            {...(props.fontSize === undefined ? {} : { fontSize: props.fontSize })}
            {...(props.contentWidth === undefined ? {} : { contentWidth: props.contentWidth })}
            {...(props.contentPadding === undefined ? {} : { contentPadding: props.contentPadding })}
            {...(props.onHunkIndices === undefined ? {} : { onHunkIndices: props.onHunkIndices })}
            {...(props.listRef === undefined ? {} : { listRef: props.listRef })}
            {...(props.listHeader === undefined ? {} : { listHeader: props.listHeader })}
            {...(props.onDerivedFontSize === undefined ? {} : { onDerivedFontSize: props.onDerivedFontSize })}
        />
    );
});

function DiffTruncation({ omittedLines, totalLines, omittedChars }: { omittedLines?: number; totalLines?: number; omittedChars?: number }) {
    if ((omittedLines ?? 0) === 0 && (omittedChars ?? 0) === 0) return null;
    return <Text style={{ color: '#888', padding: 8 }}>showing {Math.max(0, (totalLines ?? 0) - (omittedLines ?? 0))} of {totalLines ?? 0} lines ({omittedLines ?? 0} omitted, {omittedChars ?? 0} chars)</Text>;
}

type NativePatchRow =
    | { kind: 'file'; raw: string; name: string }
    | { kind: 'hunk'; raw: string; oldStart: number; newStart: number }
    | { kind: 'meta'; raw: string }
    | { kind: 'code'; raw: string; prefix: ' ' | '+' | '-'; oldLine?: number; newLine?: number; sourceIndex: number };

/** Give a phone the reading aids a terminal gets from its surrounding shell. */
function nativePatchRows(patch: string, disableFileHeader: boolean): NativePatchRow[] {
    const lines = patch.split('\n');
    const rows: NativePatchRow[] = [];
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let currentFile: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index]!;
        if (raw.startsWith('diff --git ')) {
            inHunk = false;
            const found = /^diff --git (?:a\/)?\S+ (?:b\/)?(.+)$/.exec(raw)?.[1];
            currentFile = found;
            if (!disableFileHeader && found !== undefined) rows.push({ kind: 'file', raw, name: found });
            continue;
        }
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk !== null) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            inHunk = true;
            rows.push({ kind: 'hunk', raw, oldStart: oldLine, newStart: newLine });
            continue;
        }
        if (raw.startsWith('+++ ')) {
            const found = /^\+\+\+ (?:b\/)?([^\t]+)/.exec(raw)?.[1];
            if (!disableFileHeader && currentFile === undefined && found !== undefined && found !== '/dev/null') rows.push({ kind: 'file', raw, name: found });
            continue;
        }
        if (raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('similarity ') || raw.startsWith('dissimilarity ') || raw.startsWith('\\ No newline')) continue;
        if (raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('rename ') || raw.startsWith('Binary files')) {
            rows.push({ kind: 'meta', raw });
            continue;
        }
        if (!inHunk || raw === '' && index === lines.length - 1) continue;
        const prefix = raw.charAt(0);
        if (prefix === '+') {
            rows.push({ kind: 'code', raw, prefix, newLine, sourceIndex: index });
            newLine += 1;
        } else if (prefix === '-') {
            rows.push({ kind: 'code', raw, prefix, oldLine, sourceIndex: index });
            oldLine += 1;
        } else {
            rows.push({ kind: 'code', raw: raw === '' ? ' ' : raw, prefix: ' ', oldLine, newLine, sourceIndex: index });
            oldLine += 1;
            newLine += 1;
        }
    }
    return rows;
}

function patchFileName(patch: string): string | undefined {
    const match = /^\+\+\+\s+(?:b\/)?([^\t\n]+)/m.exec(patch);
    return match?.[1] === '/dev/null' ? undefined : match?.[1];
}

function isPatchCodeLine(line: string): boolean {
    return (line.startsWith('+') && !line.startsWith('+++'))
        || (line.startsWith('-') && !line.startsWith('---'))
        || line.startsWith(' ');
}

const FILE_ROW_HEIGHT = 36;
const HUNK_ROW_HEIGHT = 32;
/** The file rail is a list header, and getItemLayout offsets have to include it. */
const RAIL_HEIGHT = 52;

function PlainPatchView({
    patch,
    fontSize,
    contentWidth: givenWidth,
    contentPadding,
    onHunkIndices,
    listRef,
    listHeader,
    onDerivedFontSize,
    disableFileHeader = false,
    omittedLines,
    totalLines,
    omittedChars,
}: {
    patch: string;
    fontSize?: number;
    contentWidth?: number;
    contentPadding?: CodeContentPadding;
    onHunkIndices?: (indices: number[]) => void;
    listRef?: DiffListRef;
    listHeader?: React.ReactElement;
    onDerivedFontSize?: (size: number) => void;
    disableFileHeader?: boolean;
    omittedLines?: number;
    totalLines?: number;
    omittedChars?: number;
}) {
    const { theme } = useUnistyles();
    const colors = theme.colors.diff;
    const lines = React.useMemo(() => patch.split('\n'), [patch]);
    const rows = React.useMemo(() => nativePatchRows(patch, disableFileHeader), [disableFileHeader, patch]);
    const widestLineNumber = React.useMemo(
        () => rows.reduce((widest, row) => row.kind === 'code' ? Math.max(widest, row.oldLine ?? 0, row.newLine ?? 0) : widest, 0),
        [rows],
    );
    const digits = String(Math.max(1, widestLineNumber)).length;

    const [measuredWidth, setMeasuredWidth] = React.useState(0);
    const contentWidth = givenWidth ?? measuredWidth;
    const probeSizes = React.useMemo(() => {
        const base = fontSize ?? 12;
        return [base, base - 1, 10, 11, 12, 13];
    }, [fontSize]);
    const { charWidth, probe } = useMonoCharWidth(probeSizes);
    const derived = React.useMemo(
        () => contentWidth > 0 ? deriveFontSize(contentWidth, digits, 'diff', charWidth) : 12,
        [charWidth, contentWidth, digits],
    );
    React.useEffect(() => { onDerivedFontSize?.(derived); }, [derived, onDerivedFontSize]);
    const codeFontSize = fontSize ?? derived;
    const codeLineHeight = lineHeightFor(codeFontSize);
    const charW = charWidth(codeFontSize);
    const numberCharW = charWidth(codeFontSize - 1);
    const numberWidth = digits * numberCharW + 6;
    const markerWidth = charW + 4;
    const gutterWidth = diffGutterWidth(digits, numberCharW, charW);
    const codeWidth = Math.max(charW * 8, contentWidth - gutterWidth - GAP - RIGHT_INSET);
    const cols = columnsFor(codeWidth, charW);

    const language = React.useMemo(() => syntaxLanguage(undefined, patchFileName(patch)), [patch]);
    const highlightSource = React.useMemo(() => boundText(lines.map((line) => isPatchCodeLine(line) ? line.slice(1) : '').join('\n'), 600, 64 * 1024).text, [lines]);
    const highlighted = React.useMemo(() => highlightCodeLines(highlightSource, language), [highlightSource, language]);
    const codeTexts = React.useMemo(() => rows.map((row) => row.kind === 'code' ? row.raw.slice(1) : ''), [rows]);
    const layouts = React.useMemo(
        () => contentWidth > 0 ? layoutLines(codeTexts, cols) : codeTexts.map(() => ({ starts: [0], hang: 0 })),
        [codeTexts, cols, contentWidth],
    );
    const heights = React.useMemo(() => rows.map((row, index) => {
        if (row.kind === 'file') return FILE_ROW_HEIGHT;
        if (row.kind === 'hunk') return HUNK_ROW_HEIGHT;
        if (row.kind === 'meta') return Math.round(codeFontSize * 1.5);
        return (layouts[index]?.starts.length ?? 1) * codeLineHeight;
    }), [codeFontSize, codeLineHeight, layouts, rows]);
    const offsets = React.useMemo(() => prefixSums(heights), [heights]);

    // Prefix sums replace the old onLayout measurement: a hunk's position is
    // its index, and the list knows every row's height before it mounts.
    React.useEffect(() => {
        onHunkIndices?.(rows.flatMap((row, index) => row.kind === 'hunk' ? [index] : []));
    }, [onHunkIndices, rows]);

    const renderRow = (index: number) => {
        const row = rows[index]!;
        if (row.kind === 'file') {
            const name = row.name.split('/').pop() ?? row.name;
            const folder = row.name.slice(0, Math.max(0, row.name.length - name.length - 1));
            return <View style={{ height: FILE_ROW_HEIGHT, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: theme.colors.surfaceHigh, borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.outline }}>
                <Ionicons name="document-text-outline" size={15} color={theme.colors.textSecondary} />
                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 11.5, ...Typography.mono('semiBold') }}>{name}</Text>
                {folder !== '' && <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono() }}>{folder}</Text>}
            </View>;
        }
        if (row.kind === 'meta') {
            return <Text numberOfLines={1} style={{ color: colors.hunkHeaderText, fontSize: codeFontSize - 1, lineHeight: Math.round(codeFontSize * 1.5), paddingHorizontal: 11, ...Typography.mono('semiBold') }}>{row.raw}</Text>;
        }
        if (row.kind === 'hunk') {
            const context = row.raw.replace(/^@@[^@]*@@\s*/, '');
            return <View style={{ height: HUNK_ROW_HEIGHT, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.hunkHeaderBg, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.outline }}>
                <Text style={{ color: colors.hunkHeaderText, fontSize: codeFontSize - 1, ...Typography.mono('semiBold') }}>−{row.oldStart}  +{row.newStart}</Text>
                {context !== '' && <Text numberOfLines={1} style={{ flex: 1, color: colors.hunkHeaderText, opacity: 0.78, fontSize: codeFontSize - 1, ...Typography.mono() }}>{context}</Text>}
            </View>;
        }
        const added = row.prefix === '+';
        const removed = row.prefix === '-';
        const foreground = added ? colors.addedText : removed ? colors.removedText : colors.contextText;
        const background = added ? withAlpha(colors.success, 0.08) : removed ? withAlpha(colors.error, 0.08) : 'transparent';
        const layout = layouts[index]!;
        const source = highlighted[row.sourceIndex] ?? [{ text: codeTexts[index] ?? '' }];
        const visual = sliceSpans(source, layout.starts);
        const numberStyle = { textAlign: 'right' as const, color: colors.lineNumberText, fontSize: codeFontSize - 1, lineHeight: codeLineHeight, ...Typography.mono() };
        // One group per logical line, so a wrapped removed line stays one red
        // block and the marker column keeps its meaning across the break.
        return <View style={{ flexDirection: 'row', alignItems: 'flex-start', backgroundColor: background, borderLeftWidth: 2, borderLeftColor: added ? colors.success : removed ? colors.error : 'transparent' }}>
            <View>
                {visual.map((_, visualRow) => (
                    <View key={visualRow} style={{ flexDirection: 'row' }}>
                        <Text style={{ ...numberStyle, width: numberWidth }}>{visualRow === 0 ? row.oldLine ?? '' : ''}</Text>
                        <Text style={{ ...numberStyle, width: numberWidth }}>{visualRow === 0 ? row.newLine ?? '' : CONTINUATION_GLYPH}</Text>
                        <Text style={{ width: markerWidth, textAlign: 'center', color: added ? colors.success : removed ? colors.error : colors.lineNumberText, fontWeight: added || removed ? '600' : 'normal', fontSize: codeFontSize, lineHeight: codeLineHeight, ...Typography.mono() }}>
                            {visualRow === 0 ? row.prefix : ' '}
                        </Text>
                    </View>
                ))}
            </View>
            <View style={{ flex: 1, marginLeft: GAP - 2 }}>
                {visual.map((spans, visualRow) => (
                    <Text
                        key={visualRow}
                        selectable
                        numberOfLines={1}
                        ellipsizeMode="clip"
                        style={{ color: foreground, fontSize: codeFontSize, lineHeight: codeLineHeight, paddingLeft: visualRow === 0 ? 0 : layout.hang * charW, ...Typography.mono() }}
                    >
                        {spans.length === 0 ? ' ' : <SyntaxSpans spans={spans} theme={theme} fallbackColor={foreground} selectable />}
                    </Text>
                ))}
            </View>
        </View>;
    };

    const padding = contentPadding ?? { horizontal: 0, top: 0, bottom: 0 };
    return (
        <View
            style={{ flex: 1, overflow: 'hidden', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.outline, backgroundColor: theme.colors.surface }}
            onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width - padding.horizontal * 2)}
        >
            <Animated.FlatList
                ref={listRef as never}
                data={rows}
                extraData={layouts}
                keyExtractor={(_: unknown, index: number) => String(index)}
                renderItem={({ index }: ListRenderItemInfo<unknown>) => renderRow(index)}
                getItemLayout={(_: unknown, index: number) => ({
                    length: heights[index] ?? codeLineHeight,
                    offset: (offsets[index] ?? 0) + (listHeader === undefined ? 0 : RAIL_HEIGHT),
                    index,
                })}
                initialNumToRender={40}
                maxToRenderPerBatch={24}
                windowSize={7}
                removeClippedSubviews={Platform.OS === 'android'}
                showsVerticalScrollIndicator
                {...(listHeader === undefined ? {} : { ListHeaderComponent: listHeader })}
                ListFooterComponent={<DiffTruncation omittedLines={omittedLines} totalLines={totalLines ?? lines.length} omittedChars={omittedChars} />}
                contentContainerStyle={{ paddingTop: padding.top, paddingBottom: padding.bottom, paddingHorizontal: padding.horizontal }}
                style={{ flex: 1 }}
            />
            {probe}
        </View>
    );
}
