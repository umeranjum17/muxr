import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DiffView } from '@/components/diff/DiffView';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, syntaxLanguage } from '@/components/code/syntaxHighlighting';
import { withAlpha } from '@/components/ui';

export interface PierreDiffViewProps {
    oldFile?: { name: string; contents: string };
    newFile?: { name: string; contents: string };
    /** Unified diff string — alternative to oldFile/newFile. */
    patch?: string;
    diffStyle?: 'unified' | 'split';
    overflow?: 'scroll' | 'wrap';
    disableLineNumbers?: boolean;
    /** Vertical offset of each hunk, once laid out. Native only. */
    onHunkOffsets?: (offsets: number[]) => void;
    /** Hide Pierre's built-in file-name/stats header — useful when the surrounding UI already shows one. Web-only. */
    disableFileHeader?: boolean;
    /** Forces a theme override; defaults to the current app theme. */
    theme?: 'dark' | 'light';
    /** Replace Pierre's default header with custom React content. Web-only. */
    renderCustomHeader?: (fileDiff: any) => React.ReactNode;
    /** Allow expanding collapsed unchanged lines. Web-only (Pierre feature). */
    expandUnchanged?: boolean;
    /** Code font size; line height follows it. Native-only. Default 13. */
    fontSize?: number;
    /** Internal bounded-render attribution. */
    omittedLines?: number;
    totalLines?: number;
    omittedChars?: number;
}

export const PierreDiffView = React.memo(function PierreDiffView(props: PierreDiffViewProps) {
    const bounded = React.useMemo(() => props.patch === undefined ? null : boundText(props.patch), [props.patch]);
    const boundedProps = bounded === null ? props : { ...props, patch: bounded.text, omittedLines: bounded.omittedLines, totalLines: bounded.totalLines, omittedChars: bounded.omittedChars };
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
  min-height: 34px;
  padding-inline: 8px;
  background: var(--diffs-bg-context);
  border-bottom: 1px solid var(--diffs-bg-separator);
}
[data-change-icon] { width: 14px; height: 14px; }
[data-separator='line-info'],
[data-separator='line-info-basic'],
[data-separator='metadata'] { height: 24px; margin-block: 0; }
[data-separator-content] { padding-inline: 8px; border-radius: 0 !important; }
`;

const PierreDiffViewWeb = React.memo(function PierreDiffViewWeb(props: PierreDiffViewProps) {
    const { theme } = useUnistyles();
    const themeName: 'dark' | 'light' = props.theme ?? (theme.dark ? 'dark' : 'light');
    const diffsTheme = themeName === 'dark' ? 'github-dark-default' : 'github-light-default';
    const bundle = usePierreBundle();
    const oldBound = React.useMemo(() => props.oldFile === undefined ? null : boundText(props.oldFile.contents), [props.oldFile]);
    const newBound = React.useMemo(() => props.newFile === undefined ? null : boundText(props.newFile.contents), [props.newFile]);

    if (!bundle) return <DiffSkeleton />;

    const options = {
        theme: diffsTheme as any,
        diffStyle: props.diffStyle,
        overflow: props.overflow,
        disableLineNumbers: props.disableLineNumbers,
        disableFileHeader: props.disableFileHeader,
        expandUnchanged: props.expandUnchanged,
        hunkSeparators: 'line-info-basic' as const,
        diffIndicators: 'bars' as const,
        unsafeCSS: COMPACT_WEB_DIFF_CSS,
    };

    if (props.patch) {
        return <PatchFilesWeb bundle={bundle} patch={props.patch} options={options} renderCustomHeader={props.renderCustomHeader} omittedLines={props.omittedLines} totalLines={props.totalLines} omittedChars={props.omittedChars} />;
    }

    if (props.oldFile && props.newFile) {
        return <FileDiffFromFiles bundle={bundle} oldFile={{ ...props.oldFile, contents: oldBound?.text ?? props.oldFile.contents }} newFile={{ ...props.newFile, contents: newBound?.text ?? props.newFile.contents }} options={options} renderCustomHeader={props.renderCustomHeader} omittedLines={Math.max(oldBound?.omittedLines ?? 0, newBound?.omittedLines ?? 0)} totalLines={Math.max(oldBound?.totalLines ?? 0, newBound?.totalLines ?? 0)} omittedChars={(oldBound?.omittedChars ?? 0) + (newBound?.omittedChars ?? 0)} />;
    }

    return <View />;
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
        return <PlainPatchView patch={patch} wrapLines={options?.overflow === 'wrap'} disableFileHeader={options?.disableFileHeader === true} omittedLines={omittedLines} totalLines={totalLines} omittedChars={omittedChars} />;
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

function FileDiffFromFiles({
    bundle,
    oldFile,
    newFile,
    options,
    renderCustomHeader,
    omittedLines,
    totalLines,
    omittedChars,
}: {
    bundle: PierreBundle;
    oldFile: { name: string; contents: string };
    newFile: { name: string; contents: string };
    options: any;
    renderCustomHeader?: (fileDiff: any) => React.ReactNode;
    omittedLines?: number;
    totalLines?: number;
    omittedChars?: number;
}) {
    const fileDiff = React.useMemo(
        () => bundle.main.parseDiffFromFile(oldFile, newFile),
        [bundle, oldFile, newFile],
    );
    const { FileDiff } = bundle.react;
    return <View><FileDiff fileDiff={fileDiff} options={options} renderCustomHeader={renderCustomHeader} /><DiffTruncation omittedLines={omittedLines} totalLines={totalLines} omittedChars={omittedChars} /></View>;
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
// Native: no network dependencies. For oldFile/newFile we route to the classic
// plain-text DiffView; for a raw patch string we colorize lines by prefix.
// Always unified on native — `diffStyle` is intentionally ignored.
// ────────────────────────────────────────────────────────────────────────────

const PierreDiffViewNative = React.memo(function PierreDiffViewNative(props: PierreDiffViewProps) {
    const oldBound = React.useMemo(() => props.oldFile === undefined ? null : boundText(props.oldFile.contents), [props.oldFile]);
    const newBound = React.useMemo(() => props.newFile === undefined ? null : boundText(props.newFile.contents), [props.newFile]);
    if (props.patch) {
        return (
            <PlainPatchView
                patch={props.patch}
                wrapLines={props.overflow === 'wrap'}
                fontSize={props.fontSize}
                onHunkOffsets={props.onHunkOffsets}
                disableFileHeader={props.disableFileHeader === true}
                omittedLines={props.omittedLines}
                totalLines={props.totalLines}
                omittedChars={props.omittedChars}
            />
        );
    }
    if (props.oldFile && props.newFile) {
        return (
            <View>
                <DiffView
                    oldText={oldBound?.text ?? props.oldFile.contents}
                    newText={newBound?.text ?? props.newFile.contents}
                    showLineNumbers={!props.disableLineNumbers}
                    wrapLines={props.overflow === 'wrap'}
                />
                <DiffTruncation omittedLines={Math.max(oldBound?.omittedLines ?? 0, newBound?.omittedLines ?? 0)} totalLines={Math.max(oldBound?.totalLines ?? 0, newBound?.totalLines ?? 0)} omittedChars={(oldBound?.omittedChars ?? 0) + (newBound?.omittedChars ?? 0)} />
            </View>
        );
    }
    return <View />;
});

/**
 * A patch, rendered the way a terminal renders it: every line git emits, in
 * order, tinted by its prefix. No filtering, no gutter, no intra-line
 * highlighting -- those all reword what git said, and the point here is to
 * show exactly what `git diff` printed.
 */
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

function PlainPatchView({
    patch,
    wrapLines,
    fontSize,
    onHunkOffsets,
    disableFileHeader = false,
    omittedLines,
    totalLines,
    omittedChars,
}: {
    patch: string;
    wrapLines: boolean;
    fontSize?: number;
    onHunkOffsets?: (offsets: number[]) => void;
    disableFileHeader?: boolean;
    omittedLines?: number;
    totalLines?: number;
    omittedChars?: number;
}) {
    const { theme } = useUnistyles();
    const colors = theme.colors.diff;
    const codeFontSize = fontSize ?? 12;
    const lines = React.useMemo(() => patch.split('\n'), [patch]);
    const rows = React.useMemo(() => nativePatchRows(patch, disableFileHeader), [disableFileHeader, patch]);
    const language = React.useMemo(() => syntaxLanguage(undefined, patchFileName(patch)), [patch]);
    const highlightSource = React.useMemo(() => boundText(lines.map((line) => isPatchCodeLine(line) ? line.slice(1) : '').join('\n'), 600, 64 * 1024).text, [lines]);
    const highlighted = React.useMemo(() => highlightCodeLines(highlightSource, language), [highlightSource, language]);
    const truncation = <DiffTruncation omittedLines={omittedLines} totalLines={totalLines ?? lines.length} omittedChars={omittedChars} />;

    // Hunk tops, measured as they lay out, so the screen above can offer
    // next/prev jumps without knowing anything about row heights.
    const hunkTops = React.useRef<Map<number, number>>(new Map());
    React.useEffect(() => {
        hunkTops.current.clear();
        onHunkOffsets?.([]);
    }, [onHunkOffsets, patch]);
    const publishHunkTops = React.useCallback(() => {
        if (onHunkOffsets === undefined) return;
        onHunkOffsets([...hunkTops.current.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y));
    }, [onHunkOffsets]);

    return (
        <View style={{ flex: 1, overflow: 'hidden', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.outline, backgroundColor: theme.colors.surface }}>
            {rows.map((row, index) => {
                if (row.kind === 'file') {
                    const name = row.name.split('/').pop() ?? row.name;
                    const folder = row.name.slice(0, Math.max(0, row.name.length - name.length - 1));
                    return <View key={`${row.raw}:${index}`} style={{ minHeight: 36, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: theme.colors.surfaceHigh, borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.outline }}>
                        <Ionicons name="document-text-outline" size={15} color={theme.colors.textSecondary} />
                        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 11.5, ...Typography.mono('semiBold') }}>{name}</Text>
                        {folder !== '' && <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono() }}>{folder}</Text>}
                    </View>;
                }
                if (row.kind === 'meta') {
                    return <Text key={`${row.raw}:${index}`} numberOfLines={1} style={{ color: colors.hunkHeaderText, fontSize: codeFontSize - 1, lineHeight: Math.round(codeFontSize * 1.5), paddingHorizontal: 11, ...Typography.mono('semiBold') }}>{row.raw}</Text>;
                }
                if (row.kind === 'hunk') {
                    const context = row.raw.replace(/^@@[^@]*@@\s*/, '');
                    return <View key={`${row.raw}:${index}`} onLayout={(event) => {
                        hunkTops.current.set(index, event.nativeEvent.layout.y);
                        publishHunkTops();
                    }} style={{ minHeight: 32, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.hunkHeaderBg, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.outline }}>
                        <Text style={{ color: colors.hunkHeaderText, fontSize: codeFontSize - 2, ...Typography.mono('semiBold') }}>−{row.oldStart}  +{row.newStart}</Text>
                        {context !== '' && <Text numberOfLines={1} style={{ flex: 1, color: colors.hunkHeaderText, opacity: 0.78, fontSize: codeFontSize - 2, ...Typography.mono() }}>{context}</Text>}
                    </View>;
                }
                const added = row.prefix === '+';
                const removed = row.prefix === '-';
                const foreground = added ? colors.addedText : removed ? colors.removedText : colors.contextText;
                const background = added ? withAlpha(colors.success, 0.08) : removed ? withAlpha(colors.error, 0.08) : 'transparent';
                const spans = highlighted[row.sourceIndex] ?? [{ text: row.raw.slice(1) }];
                return <View key={`${row.sourceIndex}:${index}`} style={{ flexDirection: 'row', alignItems: 'flex-start', backgroundColor: background, borderLeftWidth: 2, borderLeftColor: added ? colors.success : removed ? colors.error : 'transparent' }}>
                    <View style={{ width: 54, flexDirection: 'row', paddingTop: 1, paddingRight: 5, opacity: 0.72 }}>
                        <Text style={{ width: 24, textAlign: 'right', color: colors.lineNumberText, fontSize: codeFontSize - 2, lineHeight: Math.round(codeFontSize * 1.45), ...Typography.mono() }}>{row.oldLine ?? ''}</Text>
                        <Text style={{ width: 24, textAlign: 'right', color: colors.lineNumberText, fontSize: codeFontSize - 2, lineHeight: Math.round(codeFontSize * 1.45), ...Typography.mono() }}>{row.newLine ?? ''}</Text>
                    </View>
                    <Text selectable numberOfLines={wrapLines ? undefined : 1} style={{ flex: wrapLines ? 1 : undefined, color: foreground, fontSize: codeFontSize, lineHeight: Math.round(codeFontSize * 1.45), paddingRight: 9, ...Typography.mono() }}>
                        <Text style={{ color: added ? colors.success : removed ? colors.error : colors.lineNumberText, fontWeight: added || removed ? '600' : 'normal' }}>{row.prefix}</Text>
                        <SyntaxSpans spans={spans} theme={theme} fallbackColor={foreground} selectable />
                    </Text>
                </View>;
            })}
            {truncation}
        </View>
    );
}
