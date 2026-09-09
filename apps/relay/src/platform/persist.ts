import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function unsafePath(filePath: string, expected: 'directory' | 'file'): Error {
    return new Error(`refusing relay state path that is not a regular ${expected}: ${filePath}`);
}

/** Harden only the configured app-owned directory, never its parents or a symlink target. */
export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
    try {
        const info = await lstat(directoryPath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePath(directoryPath, 'directory');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    }

    const info = await lstat(directoryPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePath(directoryPath, 'directory');

    const handle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        if (!(await handle.stat()).isDirectory()) throw unsafePath(directoryPath, 'directory');
        await handle.chmod(0o700);
    } finally {
        await handle.close();
    }
}

async function openPrivateFile(filePath: string): Promise<import('node:fs/promises').FileHandle | undefined> {
    try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink()) throw unsafePath(filePath, 'file');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }

    const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
        if (!(await handle.stat()).isFile()) throw unsafePath(filePath, 'file');
        await handle.chmod(0o600);
        return handle;
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

/** Read and repair an existing relay-owned state file without following its final symlink. */
export async function readPrivateFile(filePath: string): Promise<string | undefined> {
    await ensurePrivateDirectory(dirname(filePath));
    const handle = await openPrivateFile(filePath);
    if (handle === undefined) return undefined;
    try {
        return await handle.readFile('utf8');
    } finally {
        await handle.close();
    }
}

/** Owner-only temp file in the same directory plus rename makes replacement atomic. */
export async function writeJsonFileAtomic(filePath: string, payload: unknown): Promise<void> {
    await ensurePrivateDirectory(dirname(filePath));
    await (await openPrivateFile(filePath))?.close();

    const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let handle: import('node:fs/promises').FileHandle | undefined;
    try {
        handle = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(payload), 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, filePath);
    } finally {
        await handle?.close();
        await rm(temporary, { force: true });
    }
}

let persistChain: Promise<void> = Promise.resolve();
let persistFailureReported = false;

export function chainPersist(task: () => Promise<void>): void {
    persistChain = persistChain.then(task).then(
        () => { persistFailureReported = false; },
        (error: unknown) => {
            if (persistFailureReported) return;
            persistFailureReported = true;
            const message = error instanceof Error ? error.message : 'unknown error';
            process.stderr.write(`relay state persistence failed: ${message}\n`);
        },
    );
}

export function awaitPersistChain(): Promise<void> {
    return persistChain;
}
