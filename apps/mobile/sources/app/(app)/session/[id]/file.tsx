import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { sessionReadFile, sessionBash } from '@/sync/ops';
import { storage, useSessionFileCache } from '@/sync/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { FileIcon } from '@/components/FileIcon';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { MobileGlassSurface } from '@/components/MobileGlass';

interface FileContent {
    content: string;
    isBinary: boolean;
}

/**
 * File/diff viewer reachable from the session changes pill.
 *
 * Differences from pocketpi's version: session.shell has no cwd param (git -C
 * does the traveling) and session.readFile returns utf8 text, not base64.
 */
export default React.memo(function FileScreen() {
    const { theme } = useUnistyles();
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
    /** Run git from the file's own directory, so a repo is found wherever it lives. */
    const fileDir = filePath.slice(0, filePath.lastIndexOf('/')) || '/';

    const cached = useSessionFileCache(sessionId!, filePath);

    const [fileContent, setFileContent] = React.useState<FileContent | null>(() => {
        if (!cached) return null;
        return { content: cached.content ?? '', isBinary: cached.isBinary };
    });
    const [diffContent, setDiffContent] = React.useState<string | null>(() => cached?.diff ?? null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>('diff');
    const [isLoading, setIsLoading] = React.useState(!cached);
    const [error, setError] = React.useState<string | null>(null);
    const scrollViewRef = React.useRef<ScrollView | null>(null);
    const [fontSize, setFontSize] = React.useState(13);
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
                    .onUpdate((event) => {
                        const next = Math.round(Math.min(28, Math.max(8, pinchStart.current * event.scale)));
                        setFontSize((current) => (current === next ? current : next));
                    })
                    .runOnJS(true),
                Gesture.Native(),
            ),
        [fontSize],
    );

    const getFileLanguage = React.useCallback((path: string): string | null => {
        const ext = path.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'js':
            case 'jsx':
                return 'javascript';
            case 'ts':
            case 'tsx':
                return 'typescript';
            case 'py':
                return 'python';
            case 'html':
            case 'htm':
                return 'html';
            case 'css':
                return 'css';
            case 'json':
                return 'json';
            case 'md':
                return 'markdown';
            case 'xml':
                return 'xml';
            case 'yaml':
            case 'yml':
                return 'yaml';
            case 'sh':
            case 'bash':
                return 'bash';
            case 'sql':
                return 'sql';
            case 'go':
                return 'go';
            case 'rs':
                return 'rust';
            case 'java':
                return 'java';
            case 'c':
                return 'c';
            case 'cpp':
            case 'cc':
            case 'cxx':
                return 'cpp';
            case 'php':
                return 'php';
            case 'rb':
                return 'ruby';
            case 'swift':
                return 'swift';
            case 'kt':
                return 'kotlin';
            default:
                return null;
        }
    }, []);

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

        const loadFile = async () => {
            try {
                if (!cached) {
                    setIsLoading(true);
                }
                setError(null);

                if (isBinaryFile(filePath)) {
                    if (!isCancelled) {
                        setFileContent({ content: '', isBinary: true });
                        storage.getState().applyFileCache(sessionId!, filePath, '', null, true);
                        setIsLoading(false);
                    }
                    return;
                }

                let fetchedDiff: string | null = null;

                // Live git diff. Changes come from the whole repo while a
                // session's cwd is often one subdir of it, so anchoring this to
                // the session root meant every file outside that subdir showed
                // no diff at all. The file's own directory always finds the
                // right repo, and git takes the absolute path as a pathspec.
                // Two questions, asked in order: what is uncommitted right now
                // (diff HEAD covers staged and unstaged together), and failing
                // that, what did the last commit touching this file change.
                // Without the second, every file went blank the moment the work
                // was committed -- which is most of them, most of the time.
                if (!fetchedDiff && sessionId) {
                    const git = `git -C "${fileDir}" -c diff.mnemonicPrefix=false`;
                    for (const command of [
                        `${git} diff HEAD --no-ext-diff -- "${filePath}"`,
                        `${git} log -1 -p --no-ext-diff --format= -- "${filePath}"`,
                    ]) {
                        try {
                            const diffResponse = await sessionBash(sessionId, { command, timeout: 5000 });
                            if (isCancelled) return;
                            if (diffResponse.success && diffResponse.stdout.trim()) {
                                fetchedDiff = diffResponse.stdout;
                                setDiffContent(fetchedDiff);
                                break;
                            }
                        } catch (diffError) {
                            console.log('Could not fetch git diff:', diffError);
                        }
                    }
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
                    } else {
                        setError(response.error || 'Failed to read file');
                    }
                }
            } catch (loadError) {
                console.error('Failed to load file:', loadError);
                if (!isCancelled) {
                    setError('Failed to load file');
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadFile();

        return () => {
            isCancelled = true;
        };
    }, [filePath, fileDir, isBinaryFile, sessionId, fileName]);

    React.useEffect(() => {
        if (error) {
            Modal.alert(t('common.error'), error);
        }
    }, [error]);

    React.useEffect(() => {
        if (requestedLine !== null && requestedLine > 0) {
            setDisplayMode('file');
        } else if (diffContent) {
            setDisplayMode('diff');
        } else if (fileContent) {
            setDisplayMode('file');
        }
    }, [diffContent, fileContent, requestedLine]);

    React.useEffect(() => {
        if (!fileContent?.content || displayMode !== 'file' || requestedLine === null || requestedLine <= 0) {
            return;
        }
        const offset = Math.max(0, ((requestedLine - 1) * 20) - 40);
        requestAnimationFrame(() => {
            scrollViewRef.current?.scrollTo({ y: offset, animated: false });
        });
    }, [displayMode, fileContent?.content, requestedLine]);

    const { width: windowWidth } = useWindowDimensions();
    const isNarrow = windowWidth < 700;
    const [hunkOffsets, setHunkOffsets] = React.useState<number[]>([]);
    const hunkIndex = React.useRef(0);

    // Offsets are measured inside the diff, so they need the scroller's own
    // padding added back before they mean anything to scrollTo.
    const jumpHunk = React.useCallback((step: number) => {
        if (hunkOffsets.length === 0) return;
        const next = Math.min(hunkOffsets.length - 1, Math.max(0, hunkIndex.current + step));
        hunkIndex.current = next;
        scrollViewRef.current?.scrollTo({ y: Math.max(0, hunkOffsets[next] + 16 - 8), animated: true });
    }, [hunkOffsets]);
    const directoryOfPath = (p: string): string => {
        const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return slash > 0 ? p.slice(0, slash) : '';
    };
    const language = getFileLanguage(filePath);

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

    if (fileContent?.isBinary) {
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

            {/* File path header */}
            <MobileGlassSurface enabled={Platform.OS !== 'web'} intensity={62} style={{
                paddingHorizontal: 16,
                paddingVertical: isNarrow ? 8 : 16,
                borderBottomWidth: Platform.select({ web: 1, default: 0.5 }),
                borderBottomColor: Platform.select({ web: theme.colors.divider, default: theme.colors.glass.border }),
                backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
                flexDirection: 'row',
                alignItems: 'center'
            }}>
                <FileIcon fileName={fileName} size={20} />
                {/* On a phone the directory is worth less than the row it costs:
                    name and path share one line, path shrinking to fit. */}
                <View style={{ flex: 1, minWidth: 0, marginLeft: 10, flexDirection: isNarrow ? 'row' : 'column', alignItems: isNarrow ? 'baseline' : undefined }}>
                    <Text numberOfLines={1} ellipsizeMode="middle" style={{
                        fontSize: 14,
                        color: theme.colors.text,
                        flexShrink: 0,
                        ...Typography.default('semiBold')
                    }}>
                        {fileName}
                    </Text>
                    <Text numberOfLines={1} ellipsizeMode="head" style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...(isNarrow ? { flexShrink: 1, marginLeft: 8 } : { marginTop: 1 }),
                        ...Typography.mono()
                    }}>
                        {requestedLine !== null && requestedLine > 0
                            ? `${directoryOfPath(filePath)}:${requestedLine}${requestedColumn !== null && requestedColumn > 0 ? `:${requestedColumn}` : ''}`
                            : directoryOfPath(filePath)}
                    </Text>
                </View>
            </MobileGlassSurface>

            {/* Always present: a view that appears and disappears reads as
                arbitrary. Without a diff the tab is simply disabled. */}
            {(
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 4,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' })
                }}>
                    <View style={{
                        flexDirection: 'row',
                        gap: 2,
                        padding: 2,
                        borderRadius: 9,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: theme.colors.divider,
                        backgroundColor: theme.colors.groupped.background,
                    }}>
                        {(['diff', 'file'] as const).map((mode) => {
                            const active = displayMode === mode;
                            const disabled = mode === 'diff' && !diffContent;
                            return (
                                <Pressable
                                    key={mode}
                                    disabled={disabled}
                                    onPress={() => setDisplayMode(mode)}
                                    style={{
                                        paddingHorizontal: 12,
                                        paddingVertical: 5,
                                        borderRadius: 7,
                                        opacity: disabled ? 0.4 : 1,
                                        backgroundColor: active ? theme.colors.surface : 'transparent',
                                    }}
                                >
                                    <Text style={{
                                        fontSize: 13,
                                        color: active ? theme.colors.text : theme.colors.textSecondary,
                                        ...Typography.default(active ? 'semiBold' : undefined),
                                    }}>
                                        {mode === 'diff' ? t('files.diff') : t('files.file')}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>

                    {/* Only earns its place once there is somewhere to jump to. */}
                    {displayMode === 'diff' && hunkOffsets.length > 1 && (
                        <View style={{ flexDirection: 'row', marginLeft: 'auto', alignItems: 'center', gap: 4 }}>
                            {([['chevron-up', -1], ['chevron-down', 1]] as const).map(([icon, step]) => (
                                <Pressable
                                    key={icon}
                                    hitSlop={8}
                                    onPress={() => jumpHunk(step)}
                                    style={{ padding: 6 }}
                                >
                                    <Ionicons name={icon} size={16} color={theme.colors.text} />
                                </Pressable>
                            ))}
                        </View>
                    )}
                </View>
            )}

            {/* Content display */}
            <GestureDetector gesture={zoom}>
            <ScrollView
                ref={scrollViewRef}
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}
                showsVerticalScrollIndicator={true}
            >
                {displayMode === 'diff' && diffContent ? (
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
                ) : displayMode === 'file' && fileContent?.content ? (
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
                ) : displayMode === 'file' && fileContent && !fileContent.content ? (
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
    }
}));
