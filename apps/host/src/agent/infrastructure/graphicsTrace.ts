/**
 * Opt-in, bounded metadata trace for one graphics interaction.
 *
 * This exists to answer three questions the aggregate pipeline report cannot:
 * whether a refinement became eligible when it should, whether another pane's
 * traffic invalidated it, and how long preparation and delivery actually took.
 *
 * It is diagnostic only: every call is a no-op unless MUXR_GRAPHICS_TRACE names
 * an output file, nothing here feeds runtime decisions, and it records metadata
 * only -- never terminal contents, credentials, raw pixels, or pane ids.
 */

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Total events kept for one run; the trace stops rather than growing. */
const MAX_EVENTS = 4096;
const MAX_PANES = 64;
const FLUSH_MS = 1000;

export type TraceValue = string | number | boolean | undefined;

/** Pane identity is reduced to a per-run token: enough to tell same from other. */
function token(index: number): string {
    return `pane${index}`;
}

export class GraphicsTrace {
    private readonly events: string[] = [];
    private readonly paneTokens = new Map<string, string>();
    private recorded = 0;
    private capped = false;
    private pending = 0;
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
        this.timer = setInterval(() => { this.flush(); }, FLUSH_MS);
        this.timer.unref();
    }

    /** MUXR_GRAPHICS_TRACE=<path> is the only way to turn this on. */
    static fromEnv(): GraphicsTrace | undefined {
        const path = process.env.MUXR_GRAPHICS_TRACE?.trim();
        if (path === undefined || path === '' || path === '0') return undefined;
        try {
            return new GraphicsTrace(path);
        } catch (error) {
            process.stderr.write(`graphics trace disabled: ${error instanceof Error ? error.message : String(error)}\n`);
            return undefined;
        }
    }

    add(event: string, fields: Record<string, TraceValue> = {}): void {
        if (this.capped) return;
        if (this.recorded >= MAX_EVENTS) {
            this.capped = true;
            this.events.push(JSON.stringify({ at: this.now(), event: 'trace.capped', kept: this.recorded }));
            this.pending += 1;
            return;
        }
        const record: Record<string, TraceValue> = { at: this.now(), event };
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined) continue;
            record[key] = key === 'pane' || key === 'fenceBy'
                ? this.paneToken(String(value))
                : typeof value === 'string' ? value.slice(0, 64) : value;
        }
        this.events.push(JSON.stringify(record));
        this.recorded += 1;
        this.pending += 1;
    }

    /**
     * Fingerprint the exact frame text so the same frame can be matched at
     * handoff and at socket send. Sampled, so a large frame costs the same as a
     * small one and tracing cannot distort the timings it is measuring.
     */
    frame(event: string, text: string, fields: Record<string, TraceValue> = {}): void {
        if (this.capped) return;
        this.add(event, { ...fields, fp: fingerprint(text), frameBytes: text.length });
    }

    /** Events are buffered and written on a timer: never inside a frame path. */
    flush(): void {
        if (this.pending === 0) return;
        const lines = this.events.splice(this.events.length - this.pending, this.pending);
        this.pending = 0;
        try {
            appendFileSync(this.filePath, `${lines.join('\n')}\n`, { mode: 0o600 });
            chmodSync(this.filePath, 0o600);
        } catch (error) {
            process.stderr.write(`graphics trace write failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
    }

    close(): void {
        clearInterval(this.timer);
        this.flush();
    }

    private paneToken(paneId: string): string {
        const existing = this.paneTokens.get(paneId);
        if (existing !== undefined) return existing;
        if (this.paneTokens.size >= MAX_PANES) return 'paneOther';
        const next = token(this.paneTokens.size + 1);
        this.paneTokens.set(paneId, next);
        return next;
    }
}

function fingerprint(text: string): string {
    let hash = 0x811c9dc5;
    const sample = text.length <= 256 ? text : `${text.slice(0, 128)}${text.slice(-128)}`;
    for (let i = 0; i < sample.length; i += 1) {
        hash ^= sample.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length.toString(36)}-${hash.toString(36)}`;
}

/** One process-wide trace, resolved once at startup. */
export const graphicsTrace = GraphicsTrace.fromEnv();
