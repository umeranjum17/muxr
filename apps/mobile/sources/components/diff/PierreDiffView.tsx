import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DiffView } from '@/components/diff/DiffView';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, syntaxLanguage } from '@/components/code/syntaxHighlighting';

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
        return <PlainPatchView patch={patch} wrapLines={options?.overflow === 'wrap'} omittedLines={omittedLines} totalLines={totalLines} omittedChars={omittedChars} />;
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
    omittedLines,
    totalLines,
    omittedChars,
}: {
    patch: string;
    wrapLines: boolean;
    fontSize?: number;
    onHunkOffsets?: (offsets: number[]) => void;
    omittedLines?: number;
    totalLines?: number;
    omittedChars?: number;
}) {
    const { theme } = useUnistyles();
    const colors = theme.colors.diff;
    const codeFontSize = fontSize ?? 12;
    const lines = React.useMemo(() => patch.split('\n'), [patch]);
    const language = React.useMemo(() => syntaxLanguage(undefined, patchFileName(patch)), [patch]);
    const highlightSource = React.useMemo(() => boundText(lines.map((line) => isPatchCodeLine(line) ? line.slice(1) : '').join('\n'), 600, 64 * 1024).text, [lines]);
    const highlighted = React.useMemo(() => highlightCodeLines(highlightSource, language), [highlightSource, language]);
    const truncation = <DiffTruncation omittedLines={omittedLines} totalLines={totalLines ?? lines.length} omittedChars={omittedChars} />;

    // Hunk tops, measured as they lay out, so the screen above can offer
    // next/prev jumps without knowing anything about row heights.
    const hunkTops = React.useRef<Map<number, number>>(new Map());
    const publishHunkTops = React.useCallback(() => {
        if (onHunkOffsets === undefined) return;
        onHunkOffsets([...hunkTops.current.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y));
    }, [onHunkOffsets]);

    return (
        <View style={{ flex: 1, overflow: 'hidden' }}>
            {lines.map((line, i) => {
                const first = line.charAt(0);
                // Plumbing says nothing the surrounding UI does not already say:
                // the screen names the file, and `index`/`---`/`+++` are for
                // `git apply`, not for a reader.
                const isPlumbing =
                    line.startsWith('+++ ') ||
                    line.startsWith('--- ') ||
                    line.startsWith('diff ') ||
                    line.startsWith('index ') ||
                    line.startsWith('similarity ') ||
                    line.startsWith('dissimilarity ') ||
                    line.startsWith('\\ No newline');
                if (isPlumbing) return null;
                // These carry real information; keep them as one quiet line each.
                const isFileHeader =
                    line.startsWith('new file') ||
                    line.startsWith('deleted file') ||
                    line.startsWith('rename ') ||
                    line.startsWith('Binary files');
                const isHunkHeader = line.startsWith('@@');

                if (isHunkHeader) {
                    return (
                        <View
                            key={i}
                            onLayout={(event) => {
                                hunkTops.current.set(i, event.nativeEvent.layout.y);
                                publishHunkTops();
                            }}
                            style={{
                                backgroundColor: colors.hunkHeaderBg,
                                borderTopWidth: StyleSheet.hairlineWidth,
                                borderTopColor: colors.outline,
                                paddingHorizontal: 12,
                                paddingVertical: 5,
                            }}
                        >
                            <Text
                                numberOfLines={wrapLines ? undefined : 1}
                                style={{
                                    ...Typography.mono(),
                                    fontSize: codeFontSize - 2,
                                    lineHeight: Math.round((codeFontSize - 2) * 1.4),
                                    color: colors.hunkHeaderText,
                                }}
                            >
                                {line}
                            </Text>
                        </View>
                    );
                }

                let bg: string = 'transparent';
                let fg: string = colors.contextText;
                if (isFileHeader) {
                    fg = colors.hunkHeaderText;
                } else if (first === '+') {
                    bg = colors.addedBg;
                    fg = colors.addedText;
                } else if (first === '-') {
                    bg = colors.removedBg;
                    fg = colors.removedText;
                }

                return (
                    <Text
                        key={i}
                        numberOfLines={wrapLines ? undefined : 1}
                        style={{
                            ...Typography.mono(),
                            fontSize: codeFontSize,
                            lineHeight: Math.round(codeFontSize * 1.45),
                            backgroundColor: bg,
                            color: fg,
                            paddingHorizontal: isFileHeader ? 12 : 8,
                            fontWeight: isFileHeader ? '600' : 'normal',
                        }}
                    >
                        {isPatchCodeLine(line)
                            ? <><Text style={{ color: first === '+' ? colors.success : first === '-' ? colors.error : fg, fontWeight: '600' }}>{first}</Text><SyntaxSpans spans={i < highlighted.length - 1 ? highlighted[i]! : [{ text: line.slice(1) }]} theme={theme} fallbackColor={fg} /></>
                            : (line.length === 0 ? ' ' : line)}
                    </Text>
                );
            })}
            {truncation}
        </View>
    );
}
