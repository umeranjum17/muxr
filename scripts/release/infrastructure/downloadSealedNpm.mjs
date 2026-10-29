import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Download only; verification belongs to resolveSealedNpm before publication. */
export function downloadSealedNpm({ directory, tag }) {
    mkdirSync(directory, { recursive: true });
    const download = (names) => execFileSync('gh', ['release', 'download', tag, '--repo', process.env.GITHUB_REPOSITORY,
        '--dir', directory, ...names.flatMap((name) => ['--pattern', name])], { stdio: 'inherit' });
    download(['release-manifest.json', 'npm-manifest.json']);
    const manifest = JSON.parse(readFileSync(join(directory, 'npm-manifest.json'), 'utf8'));
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 16) throw new Error('Invalid npm artifact list');
    const names = manifest.artifacts.map((item) => item.name);
    if (names.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name))) throw new Error('Invalid npm artifact name');
    download(names);
}
