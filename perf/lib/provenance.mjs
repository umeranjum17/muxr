import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function patchedDependencies(cwd = '.') {
    const files = new Set();
    for (const patch of readdirSync(join(cwd, 'patches')).filter((name) => name.endsWith('.patch'))) {
        const text = readFileSync(join(cwd, 'patches', patch), 'utf8');
        for (const match of text.matchAll(/^\+\+\+ b\/(node_modules\/[^\r\n]+)$/gm)) files.add(match[1]);
    }
    return Object.fromEntries([...files].sort().map((path) => [path, sha256(join(cwd, path))]));
}
export function harnessIdentity(cwd = '.') {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'perf', '.github/workflows'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
    const hash = createHash('sha256');
    for (const path of [...new Set(files)].sort()) hash.update(path).update('\0').update(readFileSync(join(cwd, path))).update('\0');
    return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), sha256: hash.digest('hex') };
}
export function sourceIdentity(cwd = '.') {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    // Include untracked implementation files too; exclude generated outputs via gitignore.
    const files = git('ls-files', '-co', '--exclude-standard', '-z', '--', 'apps', 'packages', 'plugins', 'scripts', 'patches', 'package.json', 'yarn.lock', 'tsconfig.base.json', 'tsconfig.json').split('\0').filter(Boolean);
    const hash = createHash('sha256');
    const mobile = createHash('sha256');
    for (const path of [...new Set(files)].sort()) {
        // Kotlin daemon liveness markers are generated outside build/ on some
        // Gradle versions; they are not application source.
        if (path.startsWith('apps/mobile/android/.kotlin/')) continue;
        const bytes = readFileSync(join(cwd, path));
        hash.update(path).update('\0').update(bytes).update('\0');
        if (!/^(apps\/(host|relay|probe)\/|plugins\/|scripts\/)/.test(path)) mobile.update(path).update('\0').update(bytes).update('\0');
    }
    return { revision: git('rev-parse', 'HEAD'), sourceSha256: hash.digest('hex'), mobileSha256: mobile.digest('hex'), dirty: git('status', '--porcelain') !== '' };
}
