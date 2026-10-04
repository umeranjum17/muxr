import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

export function prepareManagedValidation() {
    const version = spawnSync('yarn', ['--version'], { cwd: root, encoding: 'utf8' });
    if (version.status !== 0 || version.stdout.trim() !== '1.22.22') {
        throw new Error('Managed validation requires Yarn 1.22.22 (the repository uses a Yarn v1 lockfile).');
    }
    // Keep lifecycle scripts enabled: postinstall applies patch-package, synchronizes
    // the pinned iOS framework on Darwin, and verifies the required native patches.
    run('yarn', ['install', '--frozen-lockfile', '--non-interactive', '--production=false',
        '--cache-folder', '.cache/managed-validation/yarn']);
    // Explicitly rerun the required patch/sync/verifier even for an up-to-date install.
    run('yarn', ['run', 'postinstall']);
    // The focused flow imports the public workspace exports, which point at dist.
    run('yarn', ['tsc', '--build', 'packages/contract', 'packages/crypto', 'apps/relay']);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) prepareManagedValidation();
