import * as React from 'react';
import { sync } from '@/catalog/sync';
import { runningStripLines } from '../domain/runningStrip';

/** How often the strip re-reads the screen while the agent works. */
const POLL_MS = 1_500;

/**
 * The last lines of a working agent's screen, from the passive `pane.read`
 * the terminal view already uses; reading never moves the agent's viewport.
 * Nothing is asked unless the agent is working, and the lines clear the
 * moment it stops.
 */
export function useRunningStrip(sessionId: string, active: boolean): string[] {
    const [lines, setLines] = React.useState<string[]>([]);
    React.useEffect(() => {
        if (!active) { setLines([]); return; }
        let alive = true;
        let timer: ReturnType<typeof setTimeout>;
        const read = async (): Promise<void> => {
            try {
                const { text } = await sync.request('pane.read', { sessionId, source: 'visible', ansi: false });
                if (alive) setLines((current) => { const next = runningStripLines(text); return next.join('\n') === current.join('\n') ? current : next; });
            } catch {
                if (alive) setLines([]);
            } finally {
                if (alive) timer = setTimeout(() => { void read(); }, POLL_MS);
            }
        };
        void read();
        return () => { alive = false; clearTimeout(timer); };
    }, [sessionId, active]);
    return lines;
}
