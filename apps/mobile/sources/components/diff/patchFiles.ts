export interface PatchFile {
    key: string;
    label: string;
    patch: string;
    added: number;
    removed: number;
    binary: boolean;
    status: 'added' | 'deleted' | 'modified' | 'renamed';
}

function headerPath(line: string | undefined): string | undefined {
    if (line === undefined || line === '/dev/null') return undefined;
    return line.replace(/^"|"$/g, '');
}

export function patchFiles(patch: string): PatchFile[] {
    const starts = [...patch.matchAll(/^diff --git .+$/gm)];
    if (starts.length < 2) return [];
    return starts.map((match, index) => {
        const start = match.index ?? 0;
        const end = starts[index + 1]?.index ?? patch.length;
        const filePatch = patch.slice(start, end).trimEnd();
        const plus = headerPath(/^\+\+\+\s+(?:b\/)?([^\t\n]+)/m.exec(filePatch)?.[1]);
        const minus = headerPath(/^---\s+(?:a\/)?([^\t\n]+)/m.exec(filePatch)?.[1]);
        const gitNew = headerPath(/ b\/(.+)$/.exec(match[0])?.[1]);
        const gitOld = headerPath(/ a\/(.+) b\//.exec(match[0])?.[1]);
        const clean = plus ?? minus ?? gitNew ?? gitOld ?? `File ${index + 1}`;
        let added = 0;
        let removed = 0;
        let inHunk = false;
        for (const line of filePatch.split('\n')) {
            if (line.startsWith('@@')) {
                inHunk = true;
                continue;
            }
            if (line.startsWith('diff --git')) {
                inHunk = false;
                continue;
            }
            if (!inHunk) continue;
            if (line.startsWith('+')) added += 1;
            if (line.startsWith('-')) removed += 1;
        }
        const binary = /^(?:Binary files|GIT binary patch)/m.test(filePatch);
        const status = /^(?:deleted file mode|--- .*\n\+\+\+ \/dev\/null)/m.test(filePatch)
            ? 'deleted'
            : /^(?:new file mode|--- \/dev\/null)/m.test(filePatch)
                ? 'added'
                : /^(?:similarity index|rename from|rename to)/m.test(filePatch)
                    ? 'renamed'
                    : 'modified';
        return { key: `${index}:${clean}`, label: clean, patch: filePatch, added, removed, binary, status };
    });
}

/** Expand parent segments of colliding basenames until each chip label is unique. */
export function uniqueDiffLabels(paths: string[]): string[] {
    const segments = paths.map((path) => path.replace(/^\/+/, '').split('/').filter(Boolean));
    const take = segments.map((parts) => Math.min(1, parts.length));
    for (;;) {
        const labels = segments.map((parts, index) => {
            if (parts.length === 0) return paths[index] ?? '';
            return parts.slice(-Math.max(1, take[index] ?? 1)).join('/');
        });
        const counts = new Map<string, number>();
        for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
        let grew = false;
        for (let index = 0; index < labels.length; index += 1) {
            const label = labels[index] ?? '';
            const parts = segments[index] ?? [];
            if ((counts.get(label) ?? 0) > 1 && (take[index] ?? 0) < parts.length) {
                take[index] = (take[index] ?? 1) + 1;
                grew = true;
            }
        }
        if (!grew) return labels;
    }
}
