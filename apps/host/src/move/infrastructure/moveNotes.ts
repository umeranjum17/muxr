/** Where an agent's own copy went, kept while that copy is still on this computer. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Moved = { to: string; at: string };

const FILE = 'moved-to-v1.json';

const isMoved = (value: unknown): value is Moved => {
    const note = value as Partial<Moved> | null;
    return typeof note?.to === 'string' && typeof note.at === 'string';
};

function load(home: string): Array<[string, Moved]> {
    try {
        const parsed: unknown = JSON.parse(readFileSync(join(home, FILE), 'utf8'));
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is [string, Moved] => Array.isArray(entry) && typeof entry[0] === 'string' && isMoved(entry[1]))
            : [];
    } catch {
        return [];
    }
}

/** Record where a conversation went; a note for an agent no longer here is dropped with it. */
export function rememberMovedTo(home: string, sessionId: string, to: string, liveSessionIds: readonly string[]): void {
    const kept = [...load(home).filter(([id]) => id !== sessionId && liveSessionIds.includes(id)), [sessionId, { to, at: new Date().toISOString() }] as [string, Moved]];
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, FILE), JSON.stringify(kept), { mode: 0o600 });
}

/** The computer this agent's conversation went to, if this computer still holds its copy. */
export function movedToOf(home: string, sessionId: string): string | undefined {
    return load(home).find(([id]) => id === sessionId)?.[1].to;
}
