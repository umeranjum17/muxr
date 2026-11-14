import { execFile, type ExecFileException } from 'node:child_process';

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

function exitCode(error: ExecFileException | null): number {
    if (error === null) return 0;
    return typeof error.code === 'number' ? error.code : 127;
}

/** Run a program to the end and return its output; a failure to start reads as code 127. */
export function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = execFile(file, args, { env: options.env, timeout: options.timeoutMs ?? 60_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ code: exitCode(error), stdout, stderr: stderr || (error?.message ?? '') });
        });
        if (options.input !== undefined) child.stdin?.end(options.input);
    });
}
