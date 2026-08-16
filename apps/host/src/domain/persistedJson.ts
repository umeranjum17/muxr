import { readFileSync } from 'node:fs';
import { atomicWriteJson } from './atomicWriteJson.js';

/** Load persisted JSON on startup; missing or corrupt files fall back safely. */
export function loadPersistedJson<T>(
    filePath: string,
    validate: (value: unknown) => value is T,
    fallback: T,
): T {
    try {
        const raw = readFileSync(filePath, { encoding: 'utf8' });
        const parsed: unknown = JSON.parse(raw);
        if (validate(parsed)) return parsed;
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return fallback;
        }
    }
    return fallback;
}

/** Serializes writes and collapses a burst to its latest complete state. */
export function createPersistQueue(filePath: string): { schedule(state: unknown): void } {
    let writing = false;
    let pending = false;
    let latest: unknown;

    const flush = async (): Promise<void> => {
        if (writing) return;
        writing = true;
        try {
            while (pending) {
                pending = false;
                await atomicWriteJson(filePath, latest);
            }
        } catch {
            // Persistence is best effort; the next mutation retries latest state.
        } finally {
            writing = false;
            if (pending) void flush();
        }
    };

    return {
        schedule(state: unknown): void {
            latest = state;
            pending = true;
            void flush();
        },
    };
}

/** Poll until persisted revision catches up (selfCheck restart simulation). */
export async function waitForPersistedRevision(
    filePath: string,
    validateRevision: (value: unknown) => number | undefined,
    expectedRevision: number,
): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const raw = readFileSync(filePath, { encoding: 'utf8' });
            const revision = validateRevision(JSON.parse(raw));
            if (revision !== undefined && revision >= expectedRevision) return;
        } catch {
            // keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`persist timeout for ${filePath}, expected revision >= ${expectedRevision}`);
}
