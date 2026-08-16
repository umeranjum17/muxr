import { execFile } from 'node:child_process';

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_000_000;

/*
 * Session-less shell, used to create a git worktree before the session that
 * will run in it exists. Runs through the login shell so PATH matches what the
 * user gets in a terminal.
 */
export async function runMachineShell(
    command: string,
    cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
        execFile(
            process.env['SHELL'] ?? '/bin/sh',
            ['-lc', command],
            { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
            (error, stdout, stderr) => {
                const code = (error as { code?: unknown } | null)?.code;
                resolve({
                    stdout,
                    stderr: error !== null && stderr === '' ? error.message : stderr,
                    exitCode: typeof code === 'number' ? code : error === null ? 0 : 1,
                });
            },
        );
    });
}
