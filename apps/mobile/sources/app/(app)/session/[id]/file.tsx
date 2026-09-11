import * as React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { storage, useSession, useSessionFileCache, useSessionsLoaded } from '@/catalog/store';
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
 * How long a relative deep link waits for its session root before saying so.
 * Longer than `waitUntilClientOpen`'s own 5 s reject (sync.ts:545), so a
 * transport that is merely slow still wins and only a genuine failure to
 * reach the host lands here.
 */
const ROOT_WAIT_MS = 8000;

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
    // `storage.getState()` is a snapshot, not a subscription. On a cold start
    // the catalog has not hydrated yet, so this read returned undefined and
    // nothing ever told React to look again - `sessionPath` stayed null for
    // the life of the screen. `useSession` subscribes, so the effects below
    // re-run the moment the session arrives.
    const session = useSession(sessionId!);
    const sessionsLoaded = useSessionsLoaded();
    const sessionPath = session?.metadata?.path ?? null;
    const resolvedPath = resolveSessionFilePath(rawPath, sessionPath);
    // A relative path cannot be resolved without the session root:
    // `resolvePath` returns null for it, and the old `?? rawPath` fallback
    // then handed the host a relative string it resolved against its own cwd,
    // producing an ENOENT alert on every cold deep link. An absolute path
    // resolves with no root at all, so `rootMissing` is never true for one.
    //
    // `rootMissing` and `awaitingCatalog` are deliberately separate. Folding
    // `!sessionsLoaded` into the first made a completed catalog that simply
    // has no such session look resolvable, and the raw relative path went to
    // the host after all - the exact misdiagnosis this change removes. A
    // missing root is unavailable whether the catalog is still arriving or
    // has arrived and does not contain it; only the waiting differs.
    const rootMissing = resolvedPath === null;
    // The wait is bounded. `sessionsLoaded` is only set on a successful
    // refresh or when there is no transport at all, so a saved transport
    // pointing at an unreachable host leaves it false forever and an
    // unbounded wait would spin for the life of the screen. After
    // `ROOT_WAIT_MS` we stop waiting and say so; the session subscription
    // stays live, so if the catalog arrives later the screen still recovers.
    //
    // The deadline belongs to one target, not to the screen. Keyed by
    // session and raw path, so timing out on A cannot deny B its own wait,
    // and coming back to A starts a fresh one.
    const targetKey = `${sessionId ?? ''}\u0000${rawPath}`;
    const [expiredTarget, setExpiredTarget] = React.useState<string | null>(null);
    const rootWaitExpired = expiredTarget === targetKey;
    const awaitingCatalog = rootMissing && !sessionsLoaded && !rootWaitExpired;
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
    const [alertable, setAlertable] = React.useState(true);
    const neighborLoads = React.useRef(new Map<string, { cancelled: boolean }>());

    // One deadline per target. Any change of target drops the expiry recorded
    // against the old one, so timing out on A cannot deny B its wait, and
    // coming back to A later starts A's wait again rather than failing at
    // once on a verdict reached minutes ago.
    const lastTarget = React.useRef(targetKey);
    if (lastTarget.current !== targetKey) {
        lastTarget.current = targetKey;
        if (expiredTarget !== null) setExpiredTarget(null);
    }
    React.useEffect(() => {
        // Only while the root is genuinely missing and the catalog may still
        // bring it. The cleanup clears the pending timer on retarget.
        if (!rootMissing || sessionsLoaded || rootWaitExpired) return;
        const timer = setTimeout(() => setExpiredTarget(targetKey), ROOT_WAIT_MS);
        return () => { clearTimeout(timer); };
    }, [rootMissing, rootWaitExpired, sessionsLoaded, targetKey]);

    React.useEffect(() => {
        const signal = { cancelled: false };
        // Clear the previous file's state before anything else, so a stale
        // error or a stale body can never be shown against a new target.
        setError(null);
        setAlertable(true);
        setFileContent(cached ? { content: cached.content ?? '', isBinary: cached.isBinary, ...(cached.deleted === true ? { deleted: true } : {}) } : null);
        setDiffContent(cached?.diff ?? null);
        setIsLoading(cached === null);
        if (sessionId === undefined) return;
        // Nothing to ask the host yet: the path is relative and the root that
        // would make it absolute has not arrived. Stay loading rather than
        // failing, and let the session landing here run this again.
        if (awaitingCatalog) {
            setIsLoading(true);
            return;
        }
        // The root is not coming: either the wait ran out, or the catalog
        // finished and has no such session. Say so in the screen rather than
        // an alert, because retrying is the reader's call. The relative path
        // is NOT sent to the host: it would resolve against the host's own
        // working directory and report a missing file that is really a
        // missing session, the misdiagnosis this change exists to fix.
        if (rootMissing) {
            setError(t('files.sessionRootUnavailable'));
            setAlertable(false);
            setIsLoading(false);
            return;
        }
        void loadSessionDocument(sessionId, filePath, sessionPath, signal).then((result) => {
            if (signal.cancelled || result.status === 'cancelled') return;
            // A folder is an expected destination, not a fault: it belongs in the
            // screen, not behind an alert the reader has to dismiss.
            if (result.status === 'folder') {
                setError(t('files.folderNotFile'));
                setAlertable(false);
                setIsLoading(false);
                return;
            }
            if (result.status === 'error') {
                setError(result.message);
                setAlertable(true);
                setIsLoading(false);
                return;
            }
            setFileContent({ content: result.content, isBinary: result.isBinary, ...(result.deleted === true ? { deleted: true } : {}) });
            setDiffContent(result.diff);
            setIsLoading(false);
        });
        return () => { signal.cancelled = true; };
        // `cached` is deliberately not a dependency: the load writes the cache,
        // so depending on it would re-enter this effect on its own result.
    }, [awaitingCatalog, filePath, rootMissing, sessionId, sessionPath]);

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
        if (error !== null && alertable) Modal.alert(t('common.error'), error);
    }, [error, alertable]);

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
