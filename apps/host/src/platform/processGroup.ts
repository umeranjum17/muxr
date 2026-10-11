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
import { StringDecoder } from 'node:string_decoder';

const KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface ProcessGroupOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** SIGTERM the group after this many ms, SIGKILL after the grace. */
    timeoutMs?: number;
    maxBuffer?: number;
    windowsHide?: boolean;
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
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        let stdoutBytes = 0;
        let stderrBytes = 0;

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
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
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
            const bytes = (toStderr ? stderrBytes : stdoutBytes) + chunk.length;
            if (toStderr) stderrBytes = bytes;
            else stdoutBytes = bytes;
            if (bytes > maxBuffer) {
                overflowError = Object.assign(new Error('maxBuffer length exceeded'), {
                    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                });
                killGroup();
                return;
            }
            if (toStderr) stderr += stderrDecoder.write(chunk);
            else stdout += stdoutDecoder.write(chunk);
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
