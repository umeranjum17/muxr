import { sessionBash, sessionReadFile } from '@/catalog/ops';
import { storage } from '@/catalog/store';
import { gitDirectoryProbeCommand, gitDirectorySearchPaths, parentDirectory } from './fileNavigationList';
import { shellQuote } from '@/utils/shellQuote';

const GIT_DIR_CACHE_MAX = 32;
const gitDirectoryCache = new Map<string, string>();

function gitDirectoryCacheKey(sessionId: string, filePath: string, sessionPath: string | null): string {
    return `${sessionId}\0${parentDirectory(filePath) ?? ''}\0${sessionPath ?? ''}`;
}

function rememberGitDirectory(key: string, directory: string): string {
    gitDirectoryCache.delete(key);
    gitDirectoryCache.set(key, directory);
    while (gitDirectoryCache.size > GIT_DIR_CACHE_MAX) {
        const oldest = gitDirectoryCache.keys().next().value;
        if (oldest === undefined) break;
        gitDirectoryCache.delete(oldest);
    }
    return directory;
}

export type SessionDocumentLoad =
    | { status: 'ok'; content: string; isBinary: boolean; diff: string | null; deleted?: boolean }
    | { status: 'error'; message: string }
    | { status: 'cancelled' };

/**
 * Load a host-session file and optional git patch into the session file cache.
 * The viewer never prefetches; the file-route adapter does, bounded to ±1.
 */
export async function loadSessionDocument(
    sessionId: string,
    filePath: string,
    sessionPath: string | null,
    signal?: { cancelled: boolean },
): Promise<SessionDocumentLoad> {
    const cancelled = (): boolean => signal?.cancelled === true;
    try {
        let fetchedDiff: string | null = null;
        let freshDiff: string | null = null;
        let diffObserved = false;

        const gitKey = gitDirectoryCacheKey(sessionId, filePath, sessionPath);
        let gitDirectory = gitDirectoryCache.get(gitKey) ?? gitDirectorySearchPaths(filePath, sessionPath)[0] ?? '/';
        if (!gitDirectoryCache.has(gitKey)) {
            try {
                const probe = await sessionBash(sessionId, {
                    command: gitDirectoryProbeCommand(filePath, sessionPath),
                    timeout: 3000,
                });
                if (cancelled()) return { status: 'cancelled' };
                if (probe.success && probe.stdout.trim()) gitDirectory = rememberGitDirectory(gitKey, probe.stdout.trim());
            } catch (probeError) {
                console.log('Could not resolve git directory:', probeError);
            }
        }
        const git = `git -C ${shellQuote(gitDirectory)} -c diff.mnemonicPrefix=false`;
        for (const command of [
            `${git} diff HEAD --no-ext-diff -- ${shellQuote(filePath)}`,
            `${git} log -1 -p --no-ext-diff --format= -- ${shellQuote(filePath)}`,
        ]) {
            try {
                const diffResponse = await sessionBash(sessionId, { command, timeout: 5000 });
                if (cancelled()) return { status: 'cancelled' };
                if (diffResponse.success) diffObserved = true;
                if (diffResponse.success && diffResponse.stdout.trim()) {
                    freshDiff = diffResponse.stdout;
                    break;
                }
            } catch (diffError) {
                console.log('Could not fetch git diff:', diffError);
            }
        }
        if (diffObserved) fetchedDiff = freshDiff;
        else fetchedDiff = storage.getState().sessionFileCache[sessionId]?.[filePath]?.diff ?? null;

        const response = await sessionReadFile(sessionId, filePath);
        if (cancelled()) return { status: 'cancelled' };
        if (response.success && response.content !== undefined) {
            const text = response.content;
            let nonPrintable = 0;
            let hasNull = false;
            for (let index = 0; index < text.length; index++) {
                const code = text.charCodeAt(index);
                if (code === 0) hasNull = true;
                else if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
            }
            const isBinary = hasNull || (text.length > 0 && nonPrintable / text.length > 0.1);
            const content = isBinary ? '' : text;
            storage.getState().applyFileCache(sessionId, filePath, content, fetchedDiff, isBinary);
            return { status: 'ok', content, isBinary, diff: fetchedDiff };
        }
        if (fetchedDiff !== null) {
            storage.getState().applyFileCache(sessionId, filePath, '', fetchedDiff, false, true);
            return { status: 'ok', content: '', isBinary: false, diff: fetchedDiff, deleted: true };
        }
        return { status: 'error', message: response.error || 'Failed to read file' };
    } catch (loadError) {
        console.error('Failed to load file:', loadError);
        if (cancelled()) return { status: 'cancelled' };
        return { status: 'error', message: 'Failed to load file' };
    }
}
