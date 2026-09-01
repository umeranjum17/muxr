import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { sessionReadFile, sessionBash } from '@/catalog/ops';
import { storage, useSessionFileCache } from '@/catalog/store';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { resolveSessionFilePath } from '@/terminal';
import { syntaxLanguage } from '@/components/code/syntaxHighlighting';
import { PathBreadcrumb } from '@/components/PathBreadcrumb';
import { fileIcon } from '@/plugins/domain/fileIcon';
import { bundledBinaryChip, currentFileNavigation, fileNavControlLabel, gitDirectoryProbeCommand, gitDirectorySearchPaths, type FileNavigationEntry } from '@/plugins/application/fileNavigationList';
import { shellQuote } from '@/utils/shellQuote';

interface FileContent {
    content: string;
    isBinary: boolean;
}

function changeStatus(entry: FileNavigationEntry): { label: string; glyph: string; colorKey: 'added' | 'deleted' | 'modified' | 'renamed' } | undefined {
    if (entry.icon === 'add-circle-outline') return { label: 'Added', glyph: 'A', colorKey: 'added' };
    if (entry.icon === 'trash-outline') return { label: 'Deleted', glyph: 'D', colorKey: 'deleted' };
    if (entry.icon === 'swap-horizontal-outline') return { label: 'Renamed', glyph: 'R', colorKey: 'renamed' };
    if (entry.icon === 'git-compare-outline') return { label: 'Modified', glyph: 'M', colorKey: 'modified' };
    return undefined;
}

function countMeta(entry: FileNavigationEntry, tone: 'positive' | 'danger', prefix: string): string | undefined {
    return entry.metadata.find((item) => item.tone === tone && item.value.startsWith(prefix) && /^\d+$/.test(item.value.slice(prefix.length)))?.value;
}

function ChangeChip({ entry }: { entry?: FileNavigationEntry }) {
    const { theme } = useUnistyles();
    if (entry === undefined) return null;
    const status = changeStatus(entry);
    const added = countMeta(entry, 'positive', '+');
    const removed = countMeta(entry, 'danger', '−');
    const binary = bundledBinaryChip(entry.metadata);
    if (status === undefined && added === undefined && removed === undefined && !binary) return null;
    const statusColor = status?.colorKey === 'added' ? theme.colors.gitAddedText
        : status?.colorKey === 'deleted' ? theme.colors.gitRemovedText
            : status?.colorKey === 'modified' ? theme.colors.accent : theme.colors.textSecondary;
    const parts = [status?.label, added, removed, binary ? 'binary' : undefined].filter(Boolean);
    return (
        <View accessibilityRole="text" accessibilityLabel={`${entry.title}, ${parts.join(', ')}`} style={{ height: 22, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {status !== undefined && <Text style={{ color: statusColor, fontSize: 11, ...Typography.mono('semiBold') }}>{status.glyph}</Text>}
            {added !== undefined && <Text style={{ color: theme.colors.gitAddedText, fontSize: 11.5, ...Typography.mono('semiBold') }}>{added}</Text>}
            {removed !== undefined && <Text style={{ color: theme.colors.gitRemovedText, fontSize: 11.5, ...Typography.mono('semiBold') }}>{removed}</Text>}
            {binary && <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, ...Typography.mono('semiBold') }}>binary</Text>}
        </View>
    );
}

/**
 * File/diff viewer reachable from the session changes pill.
 *
 * Differences from pocketpi's version: session.shell has no cwd param (git -C
 * does the traveling) and session.readFile returns utf8 text, not base64.
 */
export default React.memo(function FileScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const searchParams = useLocalSearchParams();
    const rawPath = typeof searchParams.path === 'string' ? searchParams.path : '';
    const lineParam = searchParams.line as string | undefined;
    const columnParam = searchParams.column as string | undefined;
    const requestedLine = lineParam ? Number.parseInt(lineParam, 10) : null;
    const requestedColumn = columnParam ? Number.parseInt(columnParam, 10) : null;
    const session = storage.getState().sessions[sessionId!];
    const sessionPath = session?.metadata?.path ?? null;
    const resolvedPath = resolveSessionFilePath(rawPath, sessionPath);
    const filePath = resolvedPath?.absolutePath ?? rawPath;
    const fileName = filePath.split('/').pop() || filePath;
    const fileNavigation = sessionId === undefined ? null : (currentFileNavigation(sessionId, filePath) ?? currentFileNavigation(sessionId, rawPath));
    const fileList = fileNavigation?.entries ?? [];
    const fileIndex = fileNavigation?.index ?? -1;
    const currentEntry = fileNavigation?.entries[fileNavigation.index];

    const cached = useSessionFileCache(sessionId!, filePath);

    React.useLayoutEffect(() => {
        navigation.setOptions({ headerTitle: fileName, headerBackTitle: t('common.back') });
    }, [fileName, navigation]);

    const [fileContent, setFileContent] = React.useState<FileContent | null>(() => {
        if (!cached) return null;
        return { content: cached.content ?? '', isBinary: cached.isBinary };
    });
    const [diffContent, setDiffContent] = React.useState<string | null>(() => cached?.diff ?? null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>(() => requestedLine !== null && requestedLine > 0 ? 'file' : 'diff');
    const [isLoading, setIsLoading] = React.useState(!cached);
    const [error, setError] = React.useState<string | null>(null);
    const scrollViewRef = React.useRef<ScrollView | null>(null);
    const [fontSize, setFontSize] = React.useState(12);
    // Pinch steps the size rather than scaling continuously: the code re-lays
    // out on every change, and a smooth scale would relayout every frame.
    const pinchStart = React.useRef(13);
    const zoom = React.useMemo(
        () =>
            // Composed with the ScrollView's own gesture: alone, the scroll
            // claims the touches and the pinch never fires.
            Gesture.Simultaneous(
                Gesture.Pinch()
                    .onBegin(() => {
                        pinchStart.current = fontSize;
                    })
                    .onEnd((event) => {
                        const next = Math.round(Math.min(28, Math.max(8, pinchStart.current * event.scale)));
                        setFontSize(next);
                    })
                    .runOnJS(true),
                Gesture.Native(),
            ),
        [fontSize],
    );

    const isBinaryFile = React.useCallback((path: string): boolean => {
        const ext = path.split('.').pop()?.toLowerCase();
        const binaryExtensions = [
            'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
            'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
            'mp3', 'wav', 'flac', 'aac', 'ogg',
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'zip', 'tar', 'gz', 'rar', '7z',
            'exe', 'dmg', 'deb', 'rpm',
            'woff', 'woff2', 'ttf', 'otf',
            'db', 'sqlite', 'sqlite3'
        ];
        return ext ? binaryExtensions.includes(ext) : false;
    }, []);

    React.useEffect(() => {
        let isCancelled = false;
        setError(null);
        setFileContent(cached ? { content: cached.content ?? '', isBinary: cached.isBinary } : null);
        setDiffContent(cached?.diff ?? null);
        setIsLoading(cached === null);

        const loadFile = async () => {
            try {
                let fetchedDiff = cached?.diff ?? null;
                let freshDiff: string | null = null;
                let diffObserved = false;

                // Discover git from the opened file's nearest existing directory
                // so a third-party path outside the session cwd, or a nested
                // repo, still diffs. Session cwd is only the last fallback when
                // that directory is gone. Absolute pathspec stays quoted.
                if (sessionId) {
                    let gitDirectory = gitDirectorySearchPaths(filePath, sessionPath)[0] ?? '/';
                    try {
                        const probe = await sessionBash(sessionId, {
                            command: gitDirectoryProbeCommand(filePath, sessionPath),
                            timeout: 3000,
                        });
                        if (isCancelled) return;
                        if (probe.success && probe.stdout.trim()) gitDirectory = probe.stdout.trim();
                    } catch (probeError) {
                        console.log('Could not resolve git directory:', probeError);
                    }
                    const git = `git -C ${shellQuote(gitDirectory)} -c diff.mnemonicPrefix=false`;
                    for (const command of [
                        `${git} diff HEAD --no-ext-diff -- ${shellQuote(filePath)}`,
                        `${git} log -1 -p --no-ext-diff --format= -- ${shellQuote(filePath)}`,
                    ]) {
                        try {
                            const diffResponse = await sessionBash(sessionId, { command, timeout: 5000 });
                            if (isCancelled) return;
                            if (diffResponse.success) diffObserved = true;
                            if (diffResponse.success && diffResponse.stdout.trim()) {
                                freshDiff = diffResponse.stdout;
                                break;
                            }
                        } catch (diffError) {
                            console.log('Could not fetch git diff:', diffError);
                        }
                    }
                }
                if (diffObserved) {
                    fetchedDiff = freshDiff;
                    if (!isCancelled) setDiffContent(fetchedDiff);
                }

                if (isBinaryFile(filePath)) {
                    if (!isCancelled) {
                        const isBinary = fetchedDiff === null;
                        setFileContent({ content: '', isBinary });
                        storage.getState().applyFileCache(sessionId!, filePath, '', fetchedDiff, isBinary);
                    }
                    return;
                }

                const response = await sessionReadFile(sessionId, filePath);

                if (!isCancelled) {
                    if (response.success && response.content !== undefined) {
                        const text = response.content;
                        let nonPrintable = 0;
                        let hasNull = false;
                        for (let i = 0; i < text.length; i++) {
                            const code = text.charCodeAt(i);
                            if (code === 0) hasNull = true;
                            else if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
                        }
                        const isBinary = hasNull || (text.length > 0 && nonPrintable / text.length > 0.1);
                        const content = isBinary ? '' : text;
                        setFileContent({ content, isBinary });
                        storage.getState().applyFileCache(sessionId!, filePath, content, fetchedDiff, isBinary);
                    } else if (fetchedDiff !== null) {
                        // Deleted files have no working-tree contents, but their
                        // diff is still the useful and truthful representation.
                        setFileContent({ content: '', isBinary: false });
                        storage.getState().applyFileCache(sessionId!, filePath, '', fetchedDiff, false);
                    } else {
                        setError(response.error || 'Failed to read file');
                    }
                }
            } catch (loadError) {
                console.error('Failed to load file:', loadError);
                if (!isCancelled) setError('Failed to load file');
            } finally {
                if (!isCancelled) setIsLoading(false);
            }
        };

        loadFile();
        return () => { isCancelled = true; };
    }, [filePath, isBinaryFile, sessionId, sessionPath]);

    React.useEffect(() => {
        if (error) {
            Modal.alert(t('common.error'), error);
        }
    }, [error]);

    const { width: windowWidth } = useWindowDimensions();
    const isNarrow = windowWidth < 700;

    React.useEffect(() => {
        if (!fileContent?.content || displayMode !== 'file' || requestedLine === null || requestedLine <= 0) return;
        const lineHeight = Math.round((fontSize - (isNarrow ? 1 : 0)) * 10 / 7);
        const offset = Math.max(0, ((requestedLine - 1) * lineHeight) - 40);
        requestAnimationFrame(() => {
            scrollViewRef.current?.scrollTo({ y: offset, animated: false });
        });
    }, [displayMode, fileContent?.content, fontSize, isNarrow, requestedLine]);
    const [hunkOffsets, setHunkOffsets] = React.useState<number[]>([]);
    const hunkIndex = React.useRef(0);
    React.useEffect(() => {
        hunkIndex.current = 0;
        setHunkOffsets([]);
    }, [filePath]);

    // Offsets are measured inside the diff, so they need the scroller's own
    // padding added back before they mean anything to scrollTo.
    const jumpHunk = React.useCallback((step: number) => {
        if (hunkOffsets.length === 0) return;
        const next = Math.min(hunkOffsets.length - 1, Math.max(0, hunkIndex.current + step));
        hunkIndex.current = next;
        scrollViewRef.current?.scrollTo({ y: Math.max(0, hunkOffsets[next] + 16 - 8), animated: true });
    }, [hunkOffsets]);
    const language = syntaxLanguage(undefined, filePath) ?? null;
    const shownMode = displayMode === 'diff' && !diffContent ? 'file' : displayMode;
    const previousFile = fileIndex > 0 ? fileList[fileIndex - 1] : undefined;
    const nextFile = fileIndex >= 0 && fileIndex < fileList.length - 1 ? fileList[fileIndex + 1] : undefined;
    const navigateFile = React.useCallback((entry: FileNavigationEntry | undefined) => {
        if (entry === undefined || sessionId === undefined) return;
        router.replace(`/session/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(entry.path)}` as never);
    }, [router, sessionId]);
    const lineSuffix = requestedLine !== null && requestedLine > 0
        ? `:${requestedLine}${requestedColumn !== null && requestedColumn > 0 ? `:${requestedColumn}` : ''}`
        : '';
    const breadcrumbSegments = React.useMemo(() => filePath.split('/').filter(Boolean).map((label, index, segments) => ({
        label: index === segments.length - 1 ? `${label}${lineSuffix}` : label,
        ...(index === segments.length - 1 ? { icon: fileIcon(fileName).name } : {}),
    })), [fileName, filePath, lineSuffix]);

    if (isLoading) {
        return (
            <View style={{
                flex: 1,
                backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
                justifyContent: 'center',
                alignItems: 'center'
            }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{
                    marginTop: 16,
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    ...Typography.default()
                }}>
                    {t('files.loadingFile', { fileName })}
                </Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={{
                flex: 1,
                backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20
            }}>
                <Text style={{
                    fontSize: 18,
                    fontWeight: 'bold',
                    color: theme.colors.textDestructive,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('common.error')}
                </Text>
                <Text style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default()
                }}>
                    {error}
                </Text>
            </View>
        );
    }

    if (fileContent?.isBinary && !diffContent) {
        return (
            <View style={{
                flex: 1,
                backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20
            }}>
                <Text style={{
                    fontSize: 18,
                    fontWeight: 'bold',
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('files.binaryFile')}
                </Text>
                <Text style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default()
                }}>
                    {t('files.cannotDisplayBinary')}
                </Text>
                <Text style={{
                    fontSize: 14,
                    color: '#999',
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default()
                }}>
                    {fileName}
                </Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>

            <PathBreadcrumb segments={breadcrumbSegments} fullPath={filePath}
                {...(currentEntry === undefined ? {} : { trailing: <ChangeChip entry={currentEntry} /> })} />

            <View style={styles.controls}>
                <View style={styles.modeGroup}>
                    {(['diff', 'file'] as const).map((mode) => {
                        const active = shownMode === mode;
                        const disabled = mode === 'diff' && !diffContent;
                        return <Pressable key={mode} disabled={disabled} onPress={() => setDisplayMode(mode)} accessibilityRole="tab"
                            accessibilityLabel={mode === 'diff' ? t('files.diff') : t('files.file')}
                            accessibilityState={{ selected: active, disabled }}
                            style={({ pressed }) => [styles.mode, { backgroundColor: active ? theme.colors.surfaceSelected : pressed ? theme.colors.surfacePressed : 'transparent', opacity: disabled ? 0.45 : 1 }]}>
                            <Text style={{ color: active ? theme.colors.text : theme.colors.textSecondary, fontSize: 13, ...Typography.default(active ? 'semiBold' : undefined) }}>
                                {mode === 'diff' ? t('files.diff') : t('files.file')}
                            </Text>
                        </Pressable>;
                    })}
                </View>

                {shownMode === 'diff' && hunkOffsets.length > 1 && (
                    <View style={styles.hunkControls}>
                        {([['chevron-up', -1], ['chevron-down', 1]] as const).map(([icon, step]) => (
                            <Pressable key={icon} onPress={() => jumpHunk(step)} accessibilityRole="button"
                                accessibilityLabel={step < 0 ? 'Previous hunk' : 'Next hunk'} style={styles.hunkButton}>
                                <Ionicons name={icon} size={18} color={theme.colors.text} />
                            </Pressable>
                        ))}
                    </View>
                )}

                {fileNavigation !== null && (
                    <View style={styles.fileControls}>
                        <Pressable disabled={previousFile === undefined} onPress={() => navigateFile(previousFile)} accessibilityRole="button"
                            accessibilityLabel={fileNavControlLabel('previous', previousFile?.title, fileNavigation.index, fileNavigation.entries.length)}
                            accessibilityState={{ disabled: previousFile === undefined }} style={styles.fileButton}>
                            <Ionicons name="chevron-back" size={18} color={previousFile === undefined ? theme.colors.textSecondary : theme.colors.text} />
                        </Pressable>
                        <Text accessibilityRole="text" style={styles.filePosition}>{fileNavigation.index + 1} / {fileNavigation.entries.length}</Text>
                        <Pressable disabled={nextFile === undefined} onPress={() => navigateFile(nextFile)} accessibilityRole="button"
                            accessibilityLabel={fileNavControlLabel('next', nextFile?.title, fileNavigation.index, fileNavigation.entries.length)}
                            accessibilityState={{ disabled: nextFile === undefined }} style={styles.fileButton}>
                            <Ionicons name="chevron-forward" size={18} color={nextFile === undefined ? theme.colors.textSecondary : theme.colors.text} />
                        </Pressable>
                    </View>
                )}
            </View>

            {/* Content display */}
            <GestureDetector gesture={zoom}>
            <ScrollView
                ref={scrollViewRef}
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}
                showsVerticalScrollIndicator={true}
            >
                {shownMode === 'diff' && diffContent ? (
                    <PierreDiffView
                        patch={diffContent}
                        fontSize={fontSize}
                        // Split columns are unreadable at phone width: unified,
                        // wrapped lines there; side-by-side gets the wide view.
                        diffStyle={isNarrow ? 'unified' : undefined}
                        overflow={isNarrow ? 'wrap' : 'scroll'}
                        onHunkOffsets={setHunkOffsets}
                        disableFileHeader
                    />
                ) : shownMode === 'file' && fileContent?.content ? (
                    isNarrow ? (
                        <SimpleSyntaxHighlighter
                            code={fileContent.content}
                            language={language}
                            selectable={true}
                            lineNumbers
                            fontSize={fontSize - 1}
                        />
                    ) : (
                        <SimpleSyntaxHighlighter
                            code={fileContent.content}
                            language={language}
                            selectable={true}
                            fontSize={fontSize}
                        />
                    )
                ) : shownMode === 'file' && fileContent && !fileContent.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.fileEmpty')}
                    </Text>
                ) : !diffContent && !fileContent?.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.noChanges')}
                    </Text>
                ) : null}
            </ScrollView>
            </GestureDetector>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    controls: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    modeGroup: {
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        borderRadius: 9,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    mode: {
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 7,
        justifyContent: 'center',
        alignItems: 'center',
    },
    hunkControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginLeft: 4,
    },
    hunkButton: {
        width: 40,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    fileControls: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 'auto',
    },
    fileButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    filePosition: {
        minWidth: 38,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 11.5,
        ...Typography.mono('semiBold'),
    },
}));
