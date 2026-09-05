import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

export async function digestFile(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

export function artifactPath(directory, name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name)) throw new Error('Invalid artifact name');
    const path = join(realpathSync(directory), name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Artifact must be a regular file inside its evidence directory');
    return path;
}

export function sourceRevision(root = process.cwd()) {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    return {
        commit: git('rev-parse', 'HEAD'),
        tree: git('rev-parse', 'HEAD^{tree}'),
        dirty: git('status', '--porcelain', '--untracked-files=normal') !== '',
    };
}

export function packedMetadata(path) {
    const text = execFileSync('tar', ['-xOf', resolve(path), 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 });
    const metadata = JSON.parse(text);
    if (metadata.name !== '@trymuxr/cli') throw new Error('Unexpected npm package name');
    return metadata;
}

export function readReleaseManifest(directory) {
    const path = artifactPath(directory, 'release-manifest.json');
    if (lstatSync(path).size > 1024 * 1024) throw new Error('Release manifest is too large');
    return JSON.parse(readFileSync(path, 'utf8'));
}

export function artifactName(path) { return basename(resolve(path)); }
