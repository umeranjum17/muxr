import { execFile } from 'node:child_process';

const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** Full herdr power without a shell: each argument stays one argument. */
export function runHerdrCli(
    args: string[],
    requestedTimeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
        throw new Error('herdr: args must be a non-empty list of strings');
    }
    if (args.some((arg) => arg.includes('\0'))) throw new Error('herdr: arguments cannot contain NUL bytes');
    const requested = Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : 60_000;
    const timeout = Math.max(1_000, Math.min(requested, MAX_TIMEOUT_MS));

    return new Promise((resolve) => {
        execFile(process.env.HERDR_BIN ?? 'herdr', args, { timeout, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
            const timedOut = error !== null && 'killed' in error && error.killed === true && error.signal === 'SIGTERM';
            resolve({
                stdout,
                stderr: `${stderr}${error !== null && stderr === '' ? error.message : ''}`,
                exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
                timedOut,
            });
        });
    });
}
