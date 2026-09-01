import * as React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { storage, useSessionFileCache } from '@/catalog/store';
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveSessionFilePath } from '@/terminal';
import { DocumentViewer, type DocumentModel } from '@/components/document/DocumentViewer';
import { currentFileNavigation, openFileViewer } from '@/plugins/application/fileNavigationList';
import { loadSessionDocument } from '@/plugins/application/loadSessionDocument';

interface FileContent {
    content: string;
    isBinary: boolean;
    deleted?: boolean;
}

/**
 * Thin host-file adapter: load the session file and optional git patch, then
 * hand a neutral document to the shared viewer. The route URL stays stable.
 */
export default React.memo(function FileScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const searchParams = useLocalSearchParams();
    const rawPath = typeof searchParams.path === 'string' ? searchParams.path : '';
    const navKey = typeof searchParams.nav === 'string' ? searchParams.nav : undefined;
    const lineParam = searchParams.line as string | undefined;
    const columnParam = searchParams.column as string | undefined;
    const requestedLine = lineParam ? Number.parseInt(lineParam, 10) : null;
    const requestedColumn = columnParam ? Number.parseInt(columnParam, 10) : null;
    const session = storage.getState().sessions[sessionId!];
    const sessionPath = session?.metadata?.path ?? null;
    const resolvedPath = resolveSessionFilePath(rawPath, sessionPath);
    const filePath = resolvedPath?.absolutePath ?? rawPath;
    const fileName = filePath.split('/').pop() || filePath;
    const fileNavigation = sessionId === undefined || navKey === undefined
        ? null
        : (currentFileNavigation(sessionId, filePath, navKey) ?? currentFileNavigation(sessionId, rawPath, navKey));
    const cached = useSessionFileCache(sessionId!, filePath);

    React.useLayoutEffect(() => {
        navigation.setOptions({ headerTitle: fileName, headerBackTitle: t('common.back') });
    }, [fileName, navigation]);

    const [fileContent, setFileContent] = React.useState<FileContent | null>(() => {
        if (!cached) return null;
        return { content: cached.content ?? '', isBinary: cached.isBinary, ...(cached.deleted === true ? { deleted: true } : {}) };
    });
    const [diffContent, setDiffContent] = React.useState<string | null>(() => cached?.diff ?? null);
    const [isLoading, setIsLoading] = React.useState(!cached);
    const [error, setError] = React.useState<string | null>(null);
    const neighborLoads = React.useRef(new Map<string, { cancelled: boolean }>());

    React.useEffect(() => {
        const signal = { cancelled: false };
        setError(null);
        setFileContent(cached ? { content: cached.content ?? '', isBinary: cached.isBinary, ...(cached.deleted === true ? { deleted: true } : {}) } : null);
        setDiffContent(cached?.diff ?? null);
        setIsLoading(cached === null);
        if (sessionId === undefined) return;
        void loadSessionDocument(sessionId, filePath, sessionPath, signal).then((result) => {
            if (signal.cancelled || result.status === 'cancelled') return;
            if (result.status === 'error') {
                setError(result.message);
                setIsLoading(false);
                return;
            }
            setFileContent({ content: result.content, isBinary: result.isBinary, ...(result.deleted === true ? { deleted: true } : {}) });
            setDiffContent(result.diff);
            setIsLoading(false);
        });
        return () => { signal.cancelled = true; };
    }, [filePath, sessionId, sessionPath]);

    const previous = fileNavigation !== null && fileNavigation.index > 0 ? fileNavigation.entries[fileNavigation.index - 1] : undefined;
    const next = fileNavigation !== null && fileNavigation.index < fileNavigation.entries.length - 1
        ? fileNavigation.entries[fileNavigation.index + 1]
        : undefined;

    React.useEffect(() => {
        if (sessionId === undefined) return;
        const keep = new Set<string>([filePath]);
        if (previous?.path !== undefined) keep.add(previous.path);
        if (next?.path !== undefined) keep.add(next.path);
        for (const [path, signal] of neighborLoads.current) {
            if (keep.has(path)) continue;
            signal.cancelled = true;
            neighborLoads.current.delete(path);
        }
        const timer = setTimeout(() => {
            for (const neighbor of [previous?.path, next?.path]) {
                if (neighbor === undefined) continue;
                if (storage.getState().sessionFileCache[sessionId]?.[neighbor] !== undefined) continue;
                if (neighborLoads.current.has(neighbor)) continue;
                const signal = { cancelled: false };
                neighborLoads.current.set(neighbor, signal);
                void loadSessionDocument(sessionId, neighbor, sessionPath, signal).finally(() => {
                    if (neighborLoads.current.get(neighbor) === signal) neighborLoads.current.delete(neighbor);
                });
            }
        }, 300);
        return () => { clearTimeout(timer); };
    }, [filePath, next?.path, previous?.path, sessionId, sessionPath]);

    React.useEffect(() => () => {
        for (const signal of neighborLoads.current.values()) signal.cancelled = true;
        neighborLoads.current.clear();
    }, []);

    React.useEffect(() => {
        if (error) Modal.alert(t('common.error'), error);
    }, [error]);

    const lineSuffix = requestedLine !== null && requestedLine > 0
        ? `:${requestedLine}${requestedColumn !== null && requestedColumn > 0 ? `:${requestedColumn}` : ''}`
        : '';
    const document: DocumentModel | null = {
        path: filePath,
        fileName,
        ...(lineSuffix === '' ? {} : { lineSuffix }),
        ...(requestedLine !== null && requestedLine > 0 ? { highlightLine: requestedLine } : {}),
        ...(fileContent?.content ? { code: fileContent.content } : {}),
        ...(diffContent ? { diff: diffContent } : {}),
        ...(fileContent?.isBinary === true ? { binary: true } : {}),
        ...(fileContent !== null && fileContent.content === '' && !fileContent.isBinary && fileContent.deleted !== true ? { empty: true } : {}),
        ...(fileContent?.deleted === true ? { deleted: true } : {}),
        ...(fileNavigation === null ? {} : {
            metadata: fileNavigation.entries[fileNavigation.index]?.metadata,
            navigation: {
                index: fileNavigation.index,
                total: fileNavigation.entries.length,
                ...(previous === undefined ? {} : { previous: { path: previous.path, title: previous.title } }),
                ...(next === undefined ? {} : { next: { path: next.path, title: next.title } }),
            },
        }),
    };

    return (
        <DocumentViewer
            document={document}
            loading={isLoading}
            error={error}
            onNavigate={(path) => {
                if (sessionId === undefined) return;
                router.replace(openFileViewer({
                    sessionId,
                    path,
                    ...(navKey === undefined ? {} : { navigation: { key: navKey } }),
                }) as never);
            }}
        />
    );
});
