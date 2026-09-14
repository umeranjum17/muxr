import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface GitCheckoutIdentity {
    repoKey: string;
    checkoutKey: string;
    repoPath: string;
    repo: string;
    branch?: string;
    isLinkedWorktree: boolean;
}

const CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_NEW_PROBES_PER_TREE = 12;

function probe(cwd: string): Promise<GitCheckoutIdentity | null> {
    return new Promise((resolve) => {
        execFile('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel', '--git-dir'], {
            timeout: 500,
            maxBuffer: 2_048,
            windowsHide: true,
        }, (error, stdout) => {
            if (error !== null) { resolve(null); return; }
            const [common, checkout, gitDir] = stdout.trimEnd().split('\n');
            if (!common || !checkout || !gitDir) { resolve(null); return; }
            try {
                const repoKey = realpathSync(common);
                const checkoutKey = realpathSync(checkout);
                const repoPath = basename(repoKey) === '.git' ? dirname(repoKey) : repoKey;
                const identity: GitCheckoutIdentity = {
                    repoKey,
                    checkoutKey,
                    repoPath,
                    repo: basename(repoPath).replace(/\.git$/, ''),
                    isLinkedWorktree: realpathSync(gitDir) !== repoKey,
                };
                execFile('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
                    timeout: 500,
                    maxBuffer: 512,
                    windowsHide: true,
                }, (branchError, branch) => resolve(branchError === null && branch.trim()
                    ? { ...identity, branch: branch.trim() } : identity));
            } catch { resolve(null); }
        });
    });
}

/** Cache by live pane cwd; only a bounded number of new paths are probed per tree poll. */
export function createGitCheckoutIdentityCache() {
    const cache = new Map<string, { until: number; value: GitCheckoutIdentity | null }>();
    return async (cwds: readonly string[]): Promise<Map<string, GitCheckoutIdentity>> => {
        const now = Date.now();
        const unique = [...new Set(cwds.filter(Boolean))];
        const missing = unique.filter((cwd) => (cache.get(cwd)?.until ?? 0) <= now).slice(0, MAX_NEW_PROBES_PER_TREE);
        await Promise.all(missing.map(async (cwd) => {
            const value = await probe(cwd);
            cache.delete(cwd);
            cache.set(cwd, { until: Date.now() + CACHE_MS, value });
        }));
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
        const found = new Map<string, GitCheckoutIdentity>();
        for (const cwd of unique) {
            const entry = cache.get(cwd);
            if (entry !== undefined && entry.until > now && entry.value !== null) found.set(cwd, entry.value);
        }
        return found;
    };
}
