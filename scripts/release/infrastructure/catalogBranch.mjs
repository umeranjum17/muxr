import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG_PATH, MANIFEST_ASSET } from '../domain/channelCatalog.mjs';
import { digestFile } from './artifacts.mjs';

/**
 * The catalog branch is arbitrated the same way as the Android build ledger:
 * fast-forward-only ref updates, never a force push. A losing writer retries
 * against the branch it did not see.
 */
export function gh(repository, path, method, body) {
    const args = ['api', `repos/${repository}/${path}`];
    if (method !== undefined) args.push('--method', method);
    if (body !== undefined) args.push('--input', '-');
    const input = body === undefined ? undefined : JSON.stringify(body);
    const output = execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    // A local gh wrapper may print its own banner before the payload.
    const start = output.search(/[[{]/);
    if (start < 0) return null;
    return JSON.parse(output.slice(start));
}

export function readCatalogBranch({ repository, branch }) {
    let parent;
    try { parent = gh(repository, `git/ref/heads/${branch}`).object.sha; }
    catch (cause) { if (!String(cause.stderr).includes('404')) throw cause; }
    if (parent === undefined) return { parent: undefined, text: undefined };
    const file = gh(repository, `contents/${CATALOG_PATH}?ref=${parent}`);
    return { parent, text: Buffer.from(file.content, 'base64').toString('utf8') };
}

/** Returns false when another writer advanced the branch first. */
export function commitCatalogBranch({ repository, branch, parent, text, message }) {
    const tree = gh(repository, 'git/trees', 'POST', { tree: [{ path: CATALOG_PATH, mode: '100644', type: 'blob', content: text }] });
    const commit = gh(repository, 'git/commits', 'POST', { message, tree: tree.sha, parents: parent === undefined ? [] : [parent] });
    try {
        if (parent === undefined) gh(repository, 'git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
        else gh(repository, `git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
        return true;
    } catch (cause) {
        if (/409|422/.test(String(cause.stderr))) return false;
        throw cause;
    }
}

export function readReleaseMetadata({ repository, tag }) {
    const release = gh(repository, `releases/tags/${tag}`);
    if (release.draft !== false) throw new Error('A draft release cannot hold a public channel');
    return {
        publishedAt: release.published_at,
        prerelease: release.prerelease === true,
        id: release.id,
        name: release.name,
        assets: release.assets.map((asset) => ({ name: asset.name, size: asset.size, digest: asset.digest ?? undefined })),
    };
}

/** The commit a tag actually points at; asset names alone prove nothing. */
export function readTagCommit({ repository, tag }) {
    const ref = gh(repository, `git/ref/tags/${tag}`).object;
    if (ref.type === 'commit') return ref.sha;
    return gh(repository, `git/tags/${ref.sha}`).object.sha;
}

export function readLatestReleaseTag({ repository }) {
    try { return gh(repository, 'releases/latest').tag_name; }
    catch (cause) {
        if (String(cause.stderr).includes('404')) return undefined;
        throw cause;
    }
}

export function markReleaseLatest({ repository, id, name }) {
    return gh(repository, `releases/${id}`, 'PATCH', { prerelease: false, make_latest: 'true', name });
}

/** Downloads one retained asset and returns its path, size and digest. */
export async function withReleaseAsset({ repository, tag, name }, use) {
    const directory = mkdtempSync(join(tmpdir(), 'muxr-release-asset-'));
    try {
        downloadReleaseAsset({ repository, tag, name, directory });
        const path = join(directory, name);
        return await use({ path, bytes: statSync(path).size, sha256: await digestFile(path) });
    } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function readReleaseManifestAsset({ repository, tag }) {
    const directory = mkdtempSync(join(tmpdir(), 'muxr-release-manifest-'));
    try {
        downloadReleaseAsset({ repository, tag, name: MANIFEST_ASSET, directory });
        return JSON.parse(readFileSync(join(directory, MANIFEST_ASSET), 'utf8'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function downloadReleaseAsset({ repository, tag, name, directory }) {
    execFileSync('gh', ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', directory, '--clobber'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
