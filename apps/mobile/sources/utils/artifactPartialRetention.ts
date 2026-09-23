export async function sweepPartialDownloads(
    files: Iterable<{ modified: number | null; remove: () => void | Promise<void> }>,
    clear = false,
): Promise<void> {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const file of files) {
        if (clear || file.modified === null || file.modified < cutoff) await file.remove();
    }
}
