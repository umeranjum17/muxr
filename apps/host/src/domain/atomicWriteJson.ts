import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Atomic JSON write: temp file in the same directory, then rename. */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
    const body = `${JSON.stringify(value)}\n`;
    await writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, filePath);
}

function basename(filePath: string): string {
    const index = filePath.lastIndexOf('/');
    return index === -1 ? filePath : filePath.slice(index + 1);
}
