import { runInProcessGroup } from '../../platform/processGroup.js';
import { homePath } from '../../platform/homePath.js';

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_000_000;

/*
 * Session-less shell, used to create a git worktree before the session that
 * will run in it exists. Runs through the login shell so PATH matches what the
 * user gets in a terminal.
 *
 * The login shell runs in its own process group, so a command that backgrounds
 * a process (`npm run dev &`, a git hook) does not leave it orphaned in the
 * host unit -- and the reply is not held open by that process's stdout pipe.
 */
export async function runMachineShell(
    command: string,
    cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await runInProcessGroup(
        process.env['SHELL'] ?? '/bin/sh',
        ['-lc', command],
        { cwd: homePath(cwd), timeoutMs: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
    return {
        stdout: result.stdout,
        stderr: result.error !== null && result.stderr === '' ? result.error.message : result.stderr,
        exitCode: result.code ?? 1,
    };
}
