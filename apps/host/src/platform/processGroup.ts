/**
 * Run a child in its own process group and kill the whole group when the
 * request ends. A plain `execFile` signals only the direct child, so a shell
 * command that leaves a grandchild behind (a backgrounded process, a git hook,
 * a dev server) is orphaned, reparented, and stays charged to the host unit's
 * cgroup forever -- and the orphan holds the stdout pipe open, so the request
 * hangs until its timeout. Giving the child its own group and killing the group
 * makes a backgrounded grandchild die with its shell and the pipe close on time.
 *
 * Mirrors the proven pattern in
 * `apps/host/src/agent/infrastructure/voiceStreamManager.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process';

const KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface ProcessGroupOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** SIGTERM the group after this many ms, SIGKILL after the grace. */
    timeoutMs?: number;
    maxBuffer?: number;
    windowsHide?: boolean;
    /**
     * Launcher mode. A plugin action may deliberately start a helper (an app
     * server) and then exit 0; reaping its group would kill that helper. When
     * set, a clean exit (code 0, no signal) leaves the group running and settles
     * as soon as the direct child exits, so a helper holding our stdio pipes
     * does not turn a clean launch into a timeout. A timeout or a non-zero exit
     * still kills the group; a maxBuffer overflow settles as an error without
     * reaping it.
     */
    preserveGroupOnCleanExit?: boolean;
}

export interface ProcessGroupResult {
    stdout: string;
    stderr: string;
    /** Exit code: 0 on success, the code on failure, null when killed or not spawned. */
    code: number | null;
    /** The failure, shaped like execFile's error, so a caller keeps its wording. */
    error: Error | null;
}

interface CodedError extends Error {
    code?: unknown;
}

export function runInProcessGroup(
    file: string,
    args: readonly string[],
    options: ProcessGroupOptions = {},
): Promise<ProcessGroupResult> {
    return new Promise((resolve) => {
        const processGroup = process.platform !== 'win32';
        const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
        let child: ChildProcess;
        let settled = false;
        let exited = false;
        let exitCode: number | null = null;
        let exitSignal: NodeJS.Signals | null = null;
        let spawnError: Error | null = null;
        let overflowError: Error | null = null;
        let killTimer: NodeJS.Timeout | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let stdout = '';
        let stderr = '';
        let capturedBytes = 0;

        try {
            child = spawn(file, [...args], {
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.env === undefined ? {} : { env: options.env }),
                ...(options.windowsHide === undefined ? {} : { windowsHide: options.windowsHide }),
                detached: processGroup,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            resolve({ stdout: '', stderr: '', code: null, error: error as Error });
            return;
        }

        const finish = (): void => {
            if (settled) return;
            settled = true;
            if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
            child.stdout?.removeAllListeners('data');
            child.stderr?.removeAllListeners('data');
            child.stdout?.resume();
            child.stderr?.resume();
            let error = spawnError ?? overflowError;
            if (error === null && !(exited && exitCode === 0)) {
                // execFile reports a non-zero exit or a signal as an error.
                const reason = exitSignal === null ? `exit ${exitCode ?? 'unknown'}` : `killed by ${exitSignal}`;
                error = Object.assign(new Error(`Command failed: ${reason}`), { code: exitCode });
            }
            let code: number | null;
            if (error === null) {
                code = exitCode;
            } else if (typeof (error as CodedError).code === 'number') {
                code = (error as CodedError).code as number;
            } else {
                code = null;
            }
            resolve({ stdout, stderr, code, error });
        };

        const signalGroup = (signal: NodeJS.Signals): void => {
            if (child.pid === undefined) return;
            try {
                if (processGroup) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch { /* the group is already gone */ }
        };
        const killGroup = (): void => {
            signalGroup('SIGTERM');
            if (killTimer !== undefined) return;
            // A grandchild that ignores SIGTERM still gets SIGKILL, so its
            // stdout pipe closes and the request cannot hang on it.
            killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
            killTimer.unref();
        };
        const append = (chunk: Buffer, toStderr: boolean): void => {
            if (settled || overflowError !== null) return;
            capturedBytes += chunk.length;
            if (capturedBytes > maxBuffer) {
                overflowError = Object.assign(new Error('maxBuffer length exceeded'), {
                    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                });
                if (options.preserveGroupOnCleanExit !== true) killGroup();
                return;
            }
            if (toStderr) stderr += chunk.toString('utf8');
            else stdout += chunk.toString('utf8');
        };

        child.stdout?.on('data', (chunk: Buffer) => append(chunk, false));
        child.stderr?.on('data', (chunk: Buffer) => append(chunk, true));
        child.on('error', (error) => {
            spawnError = error;
            if (!exited) finish();
        });
        child.on('exit', (code, signal) => {
            exited = true;
            exitCode = code;
            exitSignal = signal;
            if (options.preserveGroupOnCleanExit === true && code === 0 && signal === null) {
                // A plugin action that exited cleanly may have started a helper
                // on purpose: leave the group alone and settle now, because a
                // helper holding our stdio pipes would hold 'close' open until
                // the timeout. A non-clean exit still reaps the group below.
                finish();
                return;
            }
            // The direct child exiting does not mean its group is empty: a
            // command that backgrounded a process leaves it in the group
            // holding our pipe. Reap the group the moment the shell is gone.
            killGroup();
        });
        child.on('close', (code, signal) => {
            if (!exited) {
                exited = true;
                exitCode = code;
                exitSignal = signal;
            }
            finish();
        });

        if (options.timeoutMs !== undefined) {
            timeoutTimer = setTimeout(() => killGroup(), options.timeoutMs);
        }
    });
}
