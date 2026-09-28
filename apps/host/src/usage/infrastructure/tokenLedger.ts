/**
 * Local token accounting for the Usage screen: every harness's own session
 * store, read incrementally. A transcript is read once; after that only the
 * bytes appended since are, so a machine with tens of gigabytes of sessions
 * answers in milliseconds instead of timing out. Output is hourly buckets per
 * harness, provider route and model -- counts and prices only, never prompts,
 * paths or credentials.
 *
 * Readers:
 *   pi, omp  -- Pi-format JSONL (`message.usage`, `message.provider`)
 *   claude   -- Claude Code JSONL (`message.usage`, deduped by message+request)
 *   codex    -- Codex rollouts (`token_count` events, model from `turn_context`)
 *   opencode -- the OpenCode SQLite store, read-only in a bounded child
 */
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';
import type { Harness, LedgerRow } from '../domain/activity.js';

export type { Harness, LedgerRow };

export interface LedgerRoots {
    pi?: string;
    omp?: string;
    claude?: string[];
    codex?: string;
    /** The OpenCode database file. */
    opencode?: string;
}

export interface LedgerSnapshot {
    rows: LedgerRow[];
    /** Harnesses whose store could not be read, with the reason. */
    failures: Partial<Record<Harness, string>>;
    /** Harnesses whose store exists on this machine. */
    present: Harness[];
}

/** How far back the ledger keeps records. */
export const LEDGER_DAYS = 30;
const DAY_MS = 86_400_000;
/** A line longer than this is a pasted image or file, never a usage record. */
const MAX_LINE = 64 * 1024 * 1024;
const USAGE_MARK = Buffer.from('"usage"');
const CODEX_MARK = Buffer.from('"token_count"');
const CONTEXT_MARK = Buffer.from('"turn_context"');
const META_MARK = Buffer.from('"session_meta"');

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

interface ParsedRecord extends Tokens {
    at: number;
    route: string;
    model: string;
    /** Cross-file identity: forks and resumes copy records verbatim. */
    identity?: string;
    /** USD as the harness recorded it; undefined means not recorded. */
    cost?: number;
}

interface FileState {
    harness: Exclude<Harness, 'opencode'>;
    size: number;
    mtimeMs: number;
    offset: number;
    /** Codex rollouts name the model and provider once, before their events. */
    model?: string;
    route?: string;
    lastTotal?: number;
    buckets: Map<string, LedgerRow>;
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Display-safe: printable ASCII, bounded. */
function clean(value: unknown, fallback: string): string {
    const text = String(value ?? '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 48);
    return text === '' ? fallback : text;
}

export function localHour(at: number): string {
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}`;
}

/** 31-bit FNV-1a: a small integer the dedupe sets hold without boxing. */
function hash(text: string): number {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, 0x01000193);
    }
    return value >>> 1;
}

/**
 * List prices, USD per million tokens [input, output, cache write, cache read],
 * for harnesses that record no cost of their own. A model outside these
 * families is counted and left unpriced rather than guessed.
 */
// ponytail: a static table; read the pinned pricing data if estimates drift.
const PRICES: Array<[RegExp, [number, number, number, number]]> = [
    [/claude-3-opus|opus-4-(?:1|20\d{6})|opus-4$/i, [15, 75, 18.75, 1.5]],
    [/opus/i, [5, 25, 6.25, 0.5]],
    [/sonnet/i, [3, 15, 3.75, 0.3]],
    [/haiku/i, [1, 5, 1.25, 0.1]],
    [/(?:^|[-_./])mini(?:[-_./]|$)/i, [0.25, 2, 0, 0.025]],
    [/gpt-5|gpt-6|codex|^o\d/i, [1.25, 10, 0, 0.125]],
];

export function listPrice(model: string, tokens: Tokens): number | undefined {
    const price = PRICES.find(([pattern]) => pattern.test(model))?.[1];
    if (price === undefined) return undefined;
    const [input, output, write, read] = price;
    return (tokens.input * input + tokens.output * output + tokens.cacheWrite * write + tokens.cacheRead * read) / 1_000_000;
}

// ---- Record parsers: one JSON line in, one usage record (or nothing) out ----

export function parsePiLine(line: string): ParsedRecord | undefined {
    let entry: { id?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
    try { entry = JSON.parse(line) as typeof entry; } catch { return undefined; }
    const message = entry?.message;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (message === undefined || typeof usage !== 'object' || usage === null || message.role === 'user' || message.role === 'toolResult') return undefined;
    // Pi stamps the message in epoch ms; older writers stamp it as text, and
    // some only stamp the entry.
    const stamp = message.timestamp ?? entry.timestamp;
    const at = typeof stamp === 'number' ? stamp : Date.parse(String(stamp));
    if (!Number.isFinite(at)) return undefined;
    const tokens = { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) };
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return undefined;
    const cost = (usage.cost as { total?: unknown } | undefined)?.total;
    return {
        at, ...tokens,
        route: clean(message.provider, 'unknown'),
        model: clean(message.model, 'unknown'),
        identity: `${String(entry.id ?? '')}|${String(entry.timestamp ?? '')}`,
        ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    };
}

export function parseClaudeLine(line: string): ParsedRecord | undefined {
    let entry: { timestamp?: unknown; requestId?: unknown; message?: Record<string, unknown> };
    try { entry = JSON.parse(line) as typeof entry; } catch { return undefined; }
    const message = entry?.message;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (message === undefined || typeof usage !== 'object' || usage === null || message.role === 'user') return undefined;
    const model = clean(message.model, 'unknown');
    if (model === '<synthetic>') return undefined;
    const at = Date.parse(String(entry.timestamp));
    if (!Number.isFinite(at)) return undefined;
    const tokens = {
        input: count(usage.input_tokens), output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens),
    };
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return undefined;
    // Claude Code writes one line per content block with the same usage, and a
    // resumed session copies the history: the message and request name it once.
    const identity = typeof message.id === 'string' && typeof entry.requestId === 'string' ? `${message.id}:${entry.requestId}` : undefined;
    return { at, ...tokens, route: 'anthropic', model, ...(identity === undefined ? {} : { identity }) };
}

/** Codex rollouts: stateful, since the model and provider are named once. */
export function parseCodexLine(line: string, state: Pick<FileState, 'model' | 'route' | 'lastTotal'>): ParsedRecord | undefined {
    let entry: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
    try { entry = JSON.parse(line) as typeof entry; } catch { return undefined; }
    const payload = entry?.payload;
    if (typeof payload !== 'object' || payload === null) return undefined;
    if (entry.type === 'session_meta') { state.route = clean(payload.model_provider, 'openai'); return undefined; }
    if (entry.type === 'turn_context') { if (typeof payload.model === 'string') state.model = clean(payload.model, 'unknown'); return undefined; }
    if (payload.type !== 'token_count') return undefined;
    const info = payload.info as { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> } | null | undefined;
    const total = count(info?.total_token_usage?.total_tokens);
    const last = info?.last_token_usage;
    // The same count is reported again after every turn: only a grown total is new.
    if (last === undefined || total === 0 || total <= (state.lastTotal ?? 0)) return undefined;
    state.lastTotal = total;
    const at = Date.parse(String(entry.timestamp));
    if (!Number.isFinite(at)) return undefined;
    const cached = count(last.cached_input_tokens);
    const tokens = {
        input: Math.max(0, count(last.input_tokens) - cached), output: count(last.output_tokens),
        cacheRead: cached, cacheWrite: count(last.cache_write_input_tokens),
    };
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return undefined;
    return { at, ...tokens, route: state.route ?? 'openai', model: state.model ?? 'unknown', identity: `${String(entry.timestamp)}|${total}` };
}

// ---- The ledger ----

const JSONL_HARNESSES: Array<Exclude<Harness, 'opencode'>> = ['pi', 'omp', 'claude', 'codex'];

function* jsonlFiles(directory: string, depth = 0): Generator<string> {
    // Pi nests transcripts deep on real hosts (worktree slug, session,
    // subagent, run: depth 5 observed); past 8 a tree is unread, not empty.
    if (depth > 8) throw new Error('session tree nested too deep');
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { yield* jsonlFiles(path, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        yield path;
    }
}

function exists(path: string): boolean {
    try { statSync(path); return true; } catch { return false; }
}

export class TokenLedger {
    private files = new Map<string, FileState>();
    /** Record identities already counted, by local day. */
    private seen = new Map<string, Set<number>>();
    private opencode: { stamp: string; rows: LedgerRow[] } | undefined;
    private failures: Partial<Record<Harness, string>> = {};
    private running: Promise<void> | undefined;
    /** At least one refresh has finished. */
    ready = false;

    constructor(private readonly roots: LedgerRoots) {}

    /** Bring the ledger up to date; concurrent callers share one pass. */
    refresh(now = Date.now()): Promise<void> {
        this.running ??= this.pass(now).finally(() => { this.running = undefined; this.ready = true; });
        return this.running;
    }

    snapshot(now = Date.now()): LedgerSnapshot {
        const from = localHour(now - LEDGER_DAYS * DAY_MS).slice(0, 10);
        const merged = new Map<string, LedgerRow>();
        const add = (row: LedgerRow) => {
            if (row.hour.slice(0, 10) < from) return;
            const key = `${row.harness}\u0000${row.route}\u0000${row.model}\u0000${row.hour}`;
            const held = merged.get(key);
            if (held === undefined) { merged.set(key, { ...row }); return; }
            held.input += row.input; held.output += row.output; held.cacheRead += row.cacheRead; held.cacheWrite += row.cacheWrite;
            held.cost += row.cost; held.unpriced ||= row.unpriced; held.estimated ||= row.estimated; held.latest = Math.max(held.latest, row.latest);
        };
        for (const state of this.files.values()) for (const row of state.buckets.values()) add(row);
        for (const row of this.opencode?.rows ?? []) add(row);
        const roots = this.roots;
        const present = (['pi', 'omp', 'claude', 'codex', 'opencode'] as const).filter((harness) => {
            const root = roots[harness];
            return Array.isArray(root) ? root.some(exists) : root !== undefined && exists(root);
        });
        return { rows: [...merged.values()], failures: { ...this.failures }, present };
    }

    private async pass(now: number): Promise<void> {
        const notBefore = now - (LEDGER_DAYS + 1) * DAY_MS;
        this.pruneSeen(localHour(notBefore).slice(0, 10));
        const listed = new Set<string>();
        // A rewritten transcript clears every harness's count; the second
        // round recounts them all, so this pass ends with a whole snapshot.
        for (let round = 0; round < 2; round += 1) {
            let rewritten = false;
            for (const harness of JSONL_HARNESSES) {
                const roots = harness === 'claude' ? this.roots.claude ?? [] : [this.roots[harness]].filter((root): root is string => root !== undefined);
                try {
                    for (const root of roots) {
                        for (const path of jsonlFiles(root)) {
                            listed.add(path);
                            rewritten = (await this.readFile(harness, path, notBefore)) || rewritten;
                        }
                    }
                    delete this.failures[harness];
                } catch {
                    this.failures[harness] = 'Local activity could not be measured · check the session folder can be read';
                }
            }
            if (!rewritten) break;
        }
        // A transcript that is gone takes its counts with it.
        for (const path of this.files.keys()) if (!listed.has(path)) this.files.delete(path);
        await this.readOpencode(now, notBefore);
    }

    private pruneSeen(from: string): void {
        for (const day of this.seen.keys()) if (day < from) this.seen.delete(day);
    }

    private async readFile(harness: Exclude<Harness, 'opencode'>, path: string, notBefore: number): Promise<boolean> {
        let stat;
        try { stat = statSync(path); } catch { return false; }
        // Untouched since before the window: nothing in it can count.
        if (stat.mtimeMs < notBefore) { this.files.delete(path); return false; }
        let state = this.files.get(path);
        if (state !== undefined && stat.size === state.size && stat.mtimeMs === state.mtimeMs) return false;
        let rewritten = false;
        if (state !== undefined && stat.size < state.offset) {
            // Rewritten, not appended: what it held is unknown now, and its
            // identities may be claimed. Start the whole count again.
            // ponytail: a full recount on a rewrite; rare for append-only stores.
            this.files.clear();
            this.seen.clear();
            state = undefined;
            rewritten = true;
        }
        state ??= { harness, size: 0, mtimeMs: 0, offset: 0, buckets: new Map() };
        this.files.set(path, state);
        const end = stat.size;
        if (end > state.offset) state.offset = await this.readRange(path, state, end, notBefore);
        state.size = stat.size;
        state.mtimeMs = stat.mtimeMs;
        return rewritten;
    }

    /** Read whole lines from `state.offset` up to `end`; returns the new offset
     *  (the byte after the last newline: a line still being written waits). */
    private async readRange(path: string, state: FileState, end: number, notBefore: number): Promise<number> {
        const stream = createReadStream(path, { start: state.offset, end: end - 1 });
        let offset = state.offset;
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let skipping = false;
        try {
            for await (const chunk of stream as AsyncIterable<Buffer>) {
                let start = 0;
                for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
                    const piece = chunk.subarray(start, newline);
                    if (!skipping) {
                        const line = pendingBytes === 0 ? piece : Buffer.concat([...pending, piece]);
                        this.consume(state, line, notBefore);
                    }
                    offset += pendingBytes + piece.length + 1;
                    pending = [];
                    pendingBytes = 0;
                    skipping = false;
                    start = newline + 1;
                }
                if (start < chunk.length) {
                    const rest = chunk.subarray(start);
                    if (!skipping) { pending.push(Buffer.from(rest)); }
                    pendingBytes += rest.length;
                    if (pendingBytes > MAX_LINE && !skipping) { pending = []; skipping = true; }
                }
            }
        } finally { stream.destroy(); }
        return offset;
    }

    private consume(state: FileState, line: Buffer, notBefore: number): void {
        let record: ParsedRecord | undefined;
        if (state.harness === 'codex') {
            if (line.indexOf(CODEX_MARK) < 0 && line.indexOf(CONTEXT_MARK) < 0 && line.indexOf(META_MARK) < 0) return;
            record = parseCodexLine(line.toString('utf8'), state);
        } else {
            if (line.indexOf(USAGE_MARK) < 0) return;
            const text = line.toString('utf8');
            record = state.harness === 'claude' ? parseClaudeLine(text) : parsePiLine(text);
        }
        if (record === undefined || record.at < notBefore) return;
        const hour = localHour(record.at);
        if (record.identity !== undefined) {
            const day = hour.slice(0, 10);
            let seen = this.seen.get(day);
            if (seen === undefined) { seen = new Set(); this.seen.set(day, seen); }
            const key = hash(`${state.harness}|${record.identity}`);
            if (seen.has(key)) return;
            seen.add(key);
        }
        // A recorded zero on real tokens is a harness that could not price
        // them (a subscription bridge, a plan provider), not free usage: it
        // stays unpriced, and no list price is guessed in its place.
        const recorded = record.cost !== undefined && record.cost > 0;
        let cost = record.cost;
        if (record.cost === 0) cost = undefined;
        else if (!recorded) cost = listPrice(record.model, record);
        const key = `${record.route}\u0000${record.model}\u0000${hour}`;
        let row = state.buckets.get(key);
        if (row === undefined) {
            row = { harness: state.harness, route: record.route, model: record.model, hour, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: false, estimated: false, latest: 0 };
            state.buckets.set(key, row);
        }
        row.input += record.input; row.output += record.output; row.cacheRead += record.cacheRead; row.cacheWrite += record.cacheWrite;
        if (cost === undefined) row.unpriced = true; else row.cost += cost;
        if (!recorded && cost !== undefined) row.estimated = true;
        row.latest = Math.max(row.latest, record.at);
    }

    private async readOpencode(now: number, notBefore: number): Promise<void> {
        const path = this.roots.opencode;
        if (path === undefined || !exists(path)) { delete this.failures.opencode; this.opencode = undefined; return; }
        // The store changes only when OpenCode writes: its file and WAL stamps
        // say whether the last answer still stands.
        const stamp = [path, `${path}-wal`].map((file) => { try { const s = statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } }).join('|');
        if (this.opencode?.stamp === stamp) return;
        const answer = await queryOpencode(path, notBefore, now);
        if (answer.rows === undefined) {
            this.failures.opencode = answer.unavailable === 'unsupported'
                ? 'OpenCode activity needs Node 22.13+ or Python 3 on this computer'
                : 'OpenCode database busy or unreadable · reopen Usage in a minute';
            return;
        }
        delete this.failures.opencode;
        this.opencode = {
            stamp,
            rows: answer.rows.flatMap((raw): LedgerRow[] => {
                const hour = typeof raw.hour === 'string' && /^\d{4}-\d\d-\d\dT\d\d$/.test(raw.hour) ? raw.hour : undefined;
                if (hour === undefined) return [];
                const priced = count(raw.priced);
                return [{
                    harness: 'opencode', route: clean(raw.route, 'unknown'), model: clean(raw.model, 'unknown'), hour,
                    input: count(raw.input), output: count(raw.output), cacheRead: count(raw.cacheRead), cacheWrite: count(raw.cacheWrite),
                    cost: typeof raw.cost === 'number' && Number.isFinite(raw.cost) ? Math.max(0, raw.cost) : 0,
                    unpriced: priced < count(raw.messages), estimated: false,
                    latest: typeof raw.latest === 'number' && Number.isFinite(raw.latest) ? raw.latest : 0,
                }];
            }),
        };
    }
}

// ---- OpenCode: a read-only SQLite query in a bounded child process ----

// The time column prefilters before any JSON is parsed; the grouping keeps
// the answer to one row per hour, route and model.
const OPENCODE_SQL = `SELECT strftime('%Y-%m-%dT%H', at / 1000, 'unixepoch', 'localtime') AS hour, route, model,
  sum(input) AS input, sum(output) AS output, sum(cacheRead) AS cacheRead, sum(cacheWrite) AS cacheWrite,
  sum(cost) AS cost, count(nullif(cost, 0)) AS priced, count(*) AS messages, max(at) AS latest
FROM (SELECT coalesce(json_extract(data, '$.time.completed'), json_extract(data, '$.time.created'), time_created) AS at,
    json_extract(data, '$.providerID') AS route, json_extract(data, '$.modelID') AS model,
    coalesce(json_extract(data, '$.tokens.input'), 0) AS input, coalesce(json_extract(data, '$.tokens.output'), 0) + coalesce(json_extract(data, '$.tokens.reasoning'), 0) AS output,
    coalesce(json_extract(data, '$.tokens.cache.read'), 0) AS cacheRead, coalesce(json_extract(data, '$.tokens.cache.write'), 0) AS cacheWrite,
    json_extract(data, '$.cost') AS cost
  FROM message WHERE time_created >= ?1 AND json_extract(data, '$.role') = 'assistant' AND json_type(data, '$.tokens') = 'object')
WHERE at >= ?1 AND at <= ?2 AND input + output + cacheRead + cacheWrite > 0
GROUP BY 1, 2, 3 LIMIT 20000`;

const pythonQuery = `import json,sqlite3,sys
request=json.load(sys.stdin)
db=sqlite3.connect(request['uri'],uri=True,timeout=0.5)
db.row_factory=sqlite3.Row
try:
 print(json.dumps([dict(row) for row in db.execute(request['sql'],request['params'])]))
finally:
 db.close()
`;

// Node 22.0 predates node:sqlite; Python's standard library is the read-only
// fallback. Neither launches an agent CLI, and a large store never blocks the
// host's own event loop.
const queryScript = `
import { spawnSync } from 'node:child_process';
const [path, uri, sql, from, to] = process.argv.slice(1);
const params = [Number(from), Number(to)];
let answer;
try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 500');
    try { answer = { rows: db.prepare(sql).all(...params) }; } finally { db.close(); }
} catch {
    const result = spawnSync('python3', ['-c', ${JSON.stringify(pythonQuery)}], {
        input: JSON.stringify({ uri, sql, params }),
        encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    });
    answer = result.status !== 0 || !result.stdout
        ? { unavailable: result.error ? 'unsupported' : 'database' }
        : { rows: JSON.parse(result.stdout) };
}
process.stdout.write(JSON.stringify(answer));
`;

interface OpencodeAnswer { rows?: Array<Record<string, unknown>>; unavailable?: 'database' | 'unsupported' }

function queryOpencode(path: string, from: number, to: number): Promise<OpencodeAnswer> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', queryScript, path, `${pathToFileURL(path).href}?mode=ro`, OPENCODE_SQL, String(from), String(to)], { stdio: ['ignore', 'pipe', 'ignore'] });
        let buffer = '';
        let settled = false;
        const finish = (answer: OpencodeAnswer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve(answer);
        };
        const timer = setTimeout(() => finish({ unavailable: 'database' }), 30_000);
        child.once('error', () => finish({ unavailable: 'database' }));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 16 * 1024 * 1024) finish({ unavailable: 'database' });
        });
        child.once('close', (code) => {
            if (code !== 0) { finish({ unavailable: 'database' }); return; }
            try { finish(JSON.parse(buffer) as OpencodeAnswer); } catch { finish({ unavailable: 'database' }); }
        });
    });
}

/** Pi's agent directory, as Pi itself resolves it. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.PI_AGENT_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.pi', 'agent');
}

/** Where each harness keeps its sessions on this machine, from the same
 *  configuration each harness reads. An invalid OMP profile names no root. */
export function ledgerRoots(env: NodeJS.ProcessEnv = process.env): LedgerRoots {
    const home = env.HOME?.trim() || homedir();
    let profile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
    if (!profile || profile === 'default') profile = undefined;
    const invalidProfile = profile !== undefined && (
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(profile)
    );
    let ompRoot = join(home, env.PI_CONFIG_DIR || '.omp');
    if (profile) ompRoot = join(ompRoot, 'profiles', profile);
    if (env.XDG_DATA_HOME && (profile || !env.PI_CODING_AGENT_DIR)) {
        let candidate = join(env.XDG_DATA_HOME, 'omp');
        if (profile) candidate = join(candidate, 'profiles', profile);
        if (exists(candidate)) ompRoot = candidate;
    }
    // Without a profile, a configured agent directory is the OMP agent root
    // itself; a profile still selects its own root and outranks it.
    const ompAgentDir = !profile && env.PI_CODING_AGENT_DIR?.trim() ? env.PI_CODING_AGENT_DIR.trim() : join(ompRoot, 'agent');
    // Claude Code takes a comma-separated list of config directories.
    const claudeDirs = env.CLAUDE_CONFIG_DIR?.trim()
        ? env.CLAUDE_CONFIG_DIR.split(',').map((dir) => dir.trim()).filter((dir) => dir !== '')
        : [join(home, '.claude'), join(env.XDG_CONFIG_HOME || join(home, '.config'), 'claude')];
    const opencodeRoot = env.OPENCODE_DATA_DIR || join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
    const opencodeDb = env.OPENCODE_DB || 'opencode.db';
    return {
        pi: join(piAgentDir(env), 'sessions'),
        ...(invalidProfile ? {} : { omp: join(ompAgentDir, 'sessions') }),
        claude: claudeDirs.map((dir) => join(dir, 'projects')),
        codex: join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'sessions'),
        opencode: isAbsolute(opencodeDb) ? opencodeDb : join(opencodeRoot, opencodeDb),
    };
}

const ledgers = new Map<string, TokenLedger>();

/** One ledger per set of roots, kept for the host's lifetime. */
export function ledgerFor(roots: LedgerRoots): TokenLedger {
    const key = JSON.stringify(roots);
    let ledger = ledgers.get(key);
    if (ledger === undefined) {
        ledger = new TokenLedger(roots);
        ledgers.set(key, ledger);
    }
    return ledger;
}
