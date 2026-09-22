/**
 * Usage collection: local measured activity, connected plan quota windows and
 * provider tab selection for the Usage screen and the Home "Right now" card.
 * Host product code -- provider environment access stays internal to the host,
 * and the pinned offline ccusage backend stays the measured-activity source.
 */
import { scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { UsageConnectedProvider, UsageReport, UsageSeriesPoint, UsageWindowViewModel } from '@muxr/contract';
import {
    activityTotals, claudeWindows, codexWindows, goWindows, limitsPayload, localActivityForModels,
    NOT_CONNECTED_MESSAGE, providerModelIds, tightestWindow, zaiWindows,
    type UsageDayRow, type UsageWindowVM,
} from '../domain/usageWindows.js';
import { collectLocalUsage, piAgentDir, type LocalAgentReport } from './localUsage.js';

/** Which provider tab the screen asked for; empty means most recently used. */
const MAX_PROVIDER_INPUT = 32;
/** Short tab-strip names; every other tab falls back to its AGENTS name. */
const TAB_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', gemini: 'Gemini', grok: 'Grok', kimi: 'Kimi', kilo: 'Kilo', hermes: 'Hermes', qodercli: 'Qoder', mastracode: 'Mastra' };
/** Providers with a plan collector, and the plan name each one reports. */
const PLAN_PROVIDERS: Record<string, string> = { claude: 'Claude plan', codex: 'OpenAI Codex', opencode: 'OpenCode Go', zai: 'Z.ai plan' };
const AGENTS: Record<string, string> = {
    claude: 'Anthropic Claude', codex: 'OpenAI Codex', zai: 'Z.ai', opencode: 'OpenCode', amp: 'Amp', droid: 'Droid', codebuff: 'Codebuff',
    hermes: 'Hermes Agent', pi: 'Pi', goose: 'Goose', openclaw: 'OpenClaw', kilo: 'Kilo Code', kimi: 'Kimi Code', qwen: 'Qwen',
    copilot: 'GitHub Copilot CLI', gemini: 'Gemini CLI', grok: 'xAI Grok', cursor: 'Cursor', omp: 'OMP',
    devin: 'Devin', agy: 'Antigravity', cline: 'Cline', mastracode: 'Mastra Code', kiro: 'Kiro', qodercli: 'Qoder', maki: 'Maki',
};
const CCUSAGE_AGENTS = new Set(['claude', 'codex', 'opencode', 'amp', 'droid', 'codebuff', 'hermes', 'pi', 'goose', 'openclaw', 'kilo', 'kimi', 'qwen', 'copilot', 'gemini', 'grok']);
const AGENT_COMMANDS: Record<string, string> = { ...Object.fromEntries(Object.keys(AGENTS).map((agent) => [agent, agent])), cursor: 'cursor-agent' };
const COMMAND_ALIASES: Record<string, string[]> = {
    kilo: ['kilo', 'kilocode'], cursor: ['cursor-agent'], copilot: ['copilot', 'github-copilot'],
    kiro: ['kiro-cli'], agy: ['agy', 'antigravity'], mastracode: ['mastracode', 'mastra'], qodercli: ['qodercli', 'qoder'],
};

/** Configuration env the collector reads from the host's own environment.
 *  Host-internal by design: this is not a plugin capability. */
const CONFIG_ENV_KEYS = ['HOME', 'PATH', 'XDG_DATA_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OPENCODE_DB', 'OPENCODE_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TZ'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function installedAgent(agent: string, command: string, env: NodeJS.ProcessEnv): boolean {
    return (COMMAND_ALIASES[agent] ?? [command]).some((candidate) => available(candidate, env));
}

function available(command: string, env: NodeJS.ProcessEnv): boolean {
    for (const directory of (env.PATH ?? '').split(delimiter)) {
        try { const path = join(directory, command); accessSync(path, constants.X_OK); if (statSync(path).isFile()) return true; } catch { /* not here */ }
    }
    return false;
}

/** The pinned offline ccusage backend: resolved once per collection, with the
 *  honest reason it is unavailable when it cannot serve local activity. */
function ccusageBinary(env: NodeJS.ProcessEnv): { binary?: string; failure?: string } {
    if (env.MUXR_CCUSAGE_BIN?.trim()) return { binary: env.MUXR_CCUSAGE_BIN.trim() };
    const targets: Record<string, string> = {
        'darwin-arm64': '@ccusage/ccusage-darwin-arm64', 'darwin-x64': '@ccusage/ccusage-darwin-x64',
        'linux-arm64': '@ccusage/ccusage-linux-arm64', 'linux-x64': '@ccusage/ccusage-linux-x64',
    };
    const target = targets[`${process.platform}-${process.arch}`];
    if (!target) return { failure: 'Local activity backend unsupported on this platform' };
    try {
        const binary = createRequire(import.meta.url).resolve(`${target}/bin/ccusage`);
        try { accessSync(binary, constants.X_OK); }
        catch {
            try { chmodSync(binary, 0o755); }
            catch { return { failure: 'Local activity backend is not executable · reinstall muxr without sudo' }; }
        }
        return { binary };
    } catch { return { failure: 'Local activity backend is missing · reinstall muxr' }; }
}

function runJson<T = unknown>(command: string, args: string[], timeout = 8_000): Promise<T | undefined> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let buffer = '';
        let settled = false;
        let escalation: NodeJS.Timeout | undefined;
        const finish = (value: T | undefined) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                escalation = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1_000);
            }
            resolve(value);
        };
        const timer = setTimeout(() => finish(undefined), timeout);
        child.once('error', () => finish(undefined));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 8 * 1024 * 1024) finish(undefined);
        });
        child.once('close', (code) => {
            if (escalation) clearTimeout(escalation);
            if (code !== 0) { finish(undefined); return; }
            try { finish(JSON.parse(buffer) as T); } catch { finish(undefined); }
        });
    });
}

const RANGE_DAYS = 7;

function nowDate(env: NodeJS.ProcessEnv): Date {
    const raw = env.MUXR_USAGE_NOW;
    if (raw) {
        const at = new Date(raw);
        if (!Number.isNaN(at.getTime())) return at;
    }
    return new Date();
}

function localDate(at: Date): string {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** The window we report, oldest first, always ending on today. */
function windowPeriods(origin: Date): string[] {
    // Local midnight, then setDate — fixed 86_400_000 ms skips a DST spring-forward day.
    return Array.from({ length: RANGE_DAYS }, (_, index) => {
        const at = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate());
        at.setDate(at.getDate() - (RANGE_DAYS - 1 - index));
        return localDate(at);
    });
}

interface CcusageRange {
    daily?: unknown;
    session?: unknown;
}

/**
 * One report covers every provider and every day on screen. Asking per tab
 * would re-read the same session logs once per provider.
 */
async function ccusageRange(env: NodeJS.ProcessEnv): Promise<{ range?: CcusageRange; failure?: string }> {
    const { binary, failure } = ccusageBinary(env);
    if (binary === undefined) return failure === undefined ? {} : { failure };
    const result = await runJson<CcusageRange>(binary, ['daily', '--by-agent', '--sections', 'daily,session', '--json', '--offline'], 10_000);
    if (!Array.isArray(result?.daily)) return { failure: 'Local activity unavailable · reopen Usage in a minute' };
    return { range: result };
}

function readJson(path: string, maxBytes: number): { value: unknown; modified: number } | undefined {
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return undefined;
        return { value: JSON.parse(readFileSync(path, 'utf8')) as unknown, modified: stat.mtimeMs };
    } catch { return undefined; }
}

function claudeConfigDir(env: NodeJS.ProcessEnv): string {
    return env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.claude');
}

/** A connected Claude account: local OAuth credentials that have not expired. */
function claudeCredentials(env: NodeJS.ProcessEnv): string | undefined {
    const stored = readJson(join(claudeConfigDir(env), '.credentials.json'), 64 * 1024)?.value;
    const credentials = isRecord(stored) && isRecord(stored.claudeAiOauth) ? stored.claudeAiOauth : undefined;
    const token = typeof credentials?.accessToken === 'string' && credentials.accessToken.length <= 16 * 1024 ? credentials.accessToken : undefined;
    const expired = Number.isFinite(credentials?.expiresAt) && (credentials?.expiresAt as number) <= Date.now();
    if (token === undefined || expired) return undefined;
    return token;
}

async function claudePlanLimits(env: NodeJS.ProcessEnv): Promise<unknown> {
    const snapshot = readJson(join(claudeConfigDir(env), 'last-statusline-input.json'), 64 * 1024);
    const snapshotAge = snapshot === undefined ? undefined : Date.now() - snapshot.modified;
    if (snapshot !== undefined && snapshotAge !== undefined && snapshotAge >= 0 && snapshotAge < 5 * 60_000) {
        if (claudeWindows(snapshot.value, { nowMs: Date.now() }).length > 0) return snapshot.value;
    }
    const token = claudeCredentials(env);
    if (token === undefined) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: { accept: 'application/json', authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
        if (!response.ok) return undefined;
        const body = await response.text();
        if (body.length > 64 * 1024) return undefined;
        return JSON.parse(body) as unknown;
    } catch { return undefined; }
    finally { clearTimeout(timer); }
}

/** The Go account selection, from the same source the cache identity uses.
 *  A defined OPENCODE_AUTH_CONTENT pins the account (an unusable value pins
 *  to "none" rather than falling back to another account's disk config). */
function goAuthSelection(env: NodeJS.ProcessEnv): { source: 'override' | 'disk'; auth: { type?: unknown; key?: unknown } | null | undefined } {
    if (env.OPENCODE_AUTH_CONTENT !== undefined) {
        return { source: 'override', auth: goAuthOverride(env) };
    }
    const stored = readJson(join(env.XDG_DATA_HOME || join(env.HOME?.trim() || homedir(), '.local', 'share'), 'opencode', 'auth.json'), 64 * 1024)?.value;
    const auth = isRecord(stored) ? stored['opencode-go'] : undefined;
    return { source: 'disk', auth: isRecord(auth) ? { type: auth.type, key: auth.key } : undefined };
}

/** Same shape the private projection used to hand the plugin: an unusable or
 *  absent member reads as null so the disk account is never borrowed. */
function goAuthOverride(env: NodeJS.ProcessEnv): { type?: unknown; key?: unknown } | null {
    try {
        const parsed: unknown = JSON.parse(env.OPENCODE_AUTH_CONTENT ?? '');
        const member = isRecord(parsed) ? parsed['opencode-go'] : undefined;
        if (!isRecord(member) || member.type !== 'api') return null;
        const selected: Record<string, string> = Object.create(null);
        for (const field of ['type', 'key']) {
            const value = member[field];
            if (typeof value === 'string' && value.length <= 16 * 1024) selected[field] = value;
        }
        if (Object.keys(selected).length !== 2) return null;
        return { type: selected.type, key: selected.key };
    } catch { return null; }
}

/** A connected Go account, from the same selection the cache identity uses. */
function goConnected(env: NodeJS.ProcessEnv): boolean {
    const { auth } = goAuthSelection(env);
    return auth?.type === 'api' && typeof auth.key === 'string' && auth.key.trim() !== '' && auth.key.length <= 16 * 1024;
}

interface PlanOutcome {
    vms?: UsageWindowVM[];
    label: string;
}

async function goPlanLimits(env: NodeJS.ProcessEnv): Promise<PlanOutcome> {
    if (!goConnected(env)) return { label: 'OpenCode Go limits unavailable · connect your Go account in OpenCode' };
    const { auth } = goAuthSelection(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
            headers: { accept: 'application/json', authorization: `Bearer ${auth?.key as string}` },
            redirect: 'error', signal: controller.signal,
        });
        if (response.status === 401) return { label: 'OpenCode Go authentication unavailable · reconnect in OpenCode' };
        if (response.status === 403) return { label: 'OpenCode Go subscription unavailable for this account' };
        if (!response.ok) return { label: 'OpenCode Go limits unavailable · try again shortly' };
        let body = '';
        if (response.body === null) return { label: 'OpenCode Go limits unavailable · incomplete response' };
        for await (const chunk of response.body) {
            body += Buffer.from(chunk).toString('utf8');
            if (Buffer.byteLength(body) > 64 * 1024) { controller.abort(); return { label: 'OpenCode Go limits unavailable' }; }
        }
        const usage = (JSON.parse(body) as { usage?: unknown }).usage;
        const vms = goWindows(usage, { nowMs: Date.now() });
        if (vms.length === 0) return { label: 'OpenCode Go limits unavailable · incomplete response' };
        return { vms, label: 'OpenCode Go plan usage' };
    } catch { return { label: 'OpenCode Go limits unavailable · try again shortly' }; }
    finally { clearTimeout(timer); }
}

/** The Z.ai credential Pi holds for its zai provider, from Pi's own auth store. */
function zaiToken(env: NodeJS.ProcessEnv): string | undefined {
    const stored = readJson(join(piAgentDir(env), 'auth.json'), 64 * 1024)?.value;
    const auth = isRecord(stored) && isRecord(stored.zai) ? stored.zai : undefined;
    const token = auth?.type === 'api_key' && typeof auth.key === 'string' ? auth.key.trim() : '';
    if (token === '' || token.length > 16 * 1024) return undefined;
    return token;
}

/** The models Pi routes through Z.ai, from Pi's own model registries. */
function zaiModels(env: NodeJS.ProcessEnv): Set<string> {
    const dir = piAgentDir(env);
    return new Set([
        ...providerModelIds(readJson(join(dir, 'models.json'), 256 * 1024)?.value, 'zai'),
        ...providerModelIds(readJson(join(dir, 'models-store.json'), 256 * 1024)?.value, 'zai'),
    ]);
}

async function zaiPlanLimits(env: NodeJS.ProcessEnv): Promise<PlanOutcome> {
    const token = zaiToken(env);
    if (token === undefined) return { label: 'Z.ai limits unavailable · connect Z.ai in Pi' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
            headers: { accept: 'application/json', authorization: `Bearer ${token}` },
            redirect: 'error', signal: controller.signal,
        });
        if (response.status === 401) return { label: 'Z.ai authentication unavailable · reconnect in Pi' };
        if (response.status === 403) return { label: 'Z.ai coding plan unavailable for this account' };
        if (!response.ok) return { label: 'Z.ai limits unavailable · try again shortly' };
        let body = '';
        if (response.body === null) return { label: 'Z.ai limits unavailable · incomplete response' };
        for await (const chunk of response.body) {
            body += Buffer.from(chunk).toString('utf8');
            if (Buffer.byteLength(body) > 64 * 1024) { controller.abort(); return { label: 'Z.ai limits unavailable' }; }
        }
        const parsed = JSON.parse(body) as { success?: unknown; data?: { limits?: unknown } };
        if (parsed?.success === false) return { label: 'Z.ai coding plan unavailable for this account' };
        const vms = zaiWindows(parsed?.data?.limits, { nowMs: Date.now() });
        if (vms.length === 0) return { label: 'Z.ai limits unavailable · incomplete response' };
        return { vms, label: 'Z.ai plan usage' };
    } catch { return { label: 'Z.ai limits unavailable · try again shortly' }; }
    finally { clearTimeout(timer); }
}

function money(value: number): string | undefined {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tokens(value: number | undefined): string | undefined {
    if (!Number.isSafeInteger(value) || (value ?? 0) < 0) return undefined;
    const total = value ?? 0;
    if (total >= 1_000_000_000) return `${(total / 1_000_000_000).toFixed(1)}B`;
    if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
    if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
    return String(Math.round(total));
}

function dayLabel(period: string): string {
    const parsed = new Date(`${period}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return period;
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getUTCDay()] ?? period;
}

/**
 * agent -> one entry per day of the window, so every tab reads from one report.
 * Days are placed by date rather than by position: ccusage omits days with no
 * activity, so trusting its order would slide an older day into today's slot
 * and report stale totals as current.
 */
function byAgent(result: CcusageRange | undefined, periods: string[]): Map<string, UsageDayRow[]> {
    const slots = new Map(periods.map((period, index) => [period, index]));
    const agents = new Map<string, UsageDayRow[]>();
    for (const day of Array.isArray(result?.daily) ? result!.daily as unknown[] : []) {
        const entry = isRecord(day) ? day : {};
        const index = slots.get(String(entry.period ?? ''));
        if (index === undefined) continue;
        for (const row of Array.isArray(entry.agents) ? entry.agents.slice(0, 32) : []) {
            if (!isRecord(row)) continue;
            const agent = String(row.agent ?? '');
            if (!CCUSAGE_AGENTS.has(agent) || !Number.isSafeInteger(row.totalTokens) || (row.totalTokens as number) < 0) continue;
            const days = agents.get(agent) ?? periods.map((period) => ({ period, row: undefined }));
            days[index] = { period: periods[index]!, row: row as unknown as NonNullable<UsageDayRow['row']> };
            agents.set(agent, days);
        }
    }
    return agents;
}

function modelSeries(row: UsageDayRow['row']): UsageSeriesPoint[] {
    const breakdowns = Array.isArray(row?.modelBreakdowns) ? row!.modelBreakdowns.slice(0, 8) : [];
    return breakdowns.flatMap((model) => {
        const total = (model.inputTokens ?? 0) + (model.outputTokens ?? 0) + (model.cacheCreationTokens ?? 0) + (model.cacheReadTokens ?? 0);
        const label = String(model.modelName ?? '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 40);
        const valueLabel = tokens(total);
        if (label === '' || valueLabel === undefined) return [];
        return [{ label, value: total, valueLabel }];
    }).sort((a, b) => b.value - a.value);
}

function usageStateDir(env: NodeJS.ProcessEnv): string {
    const home = env.MUXR_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.muxr');
    return join(home, 'usage');
}

function cacheName(selected: string): string {
    return `usage-v2-${selected === '' ? 'all' : selected}.json`;
}

function cachedOutput(env: NodeJS.ProcessEnv, identity: string, today: string, nowMs: number, selected: string): { output: UsageReport; stale: boolean } | undefined {
    try {
        const saved = JSON.parse(readFileSync(join(usageStateDir(env), cacheName(selected)), 'utf8')) as {
            at?: number; date?: string; identity?: string; output?: UsageReport;
        };
        const age = nowMs - (saved.at ?? Number.NaN);
        const maxAge = saved.output?.provider === 'claude' ? 15_000 : 60_000;
        // A payload captured yesterday would keep labelling its last day "Today".
        // Past the fresh window the payload still paints instantly -- flagged
        // stale so the screen refreshes itself in place -- because last-known
        // numbers beat a skeleton while a fresh collection runs.
        if (saved.identity === identity && saved.date === today && age >= 0 && Array.isArray(saved.output?.providers) && Buffer.byteLength(JSON.stringify(saved.output)) <= 65_536) {
            return { output: saved.output!, stale: age >= maxAge };
        }
    } catch { /* no cache yet */ }
    return undefined;
}

function saveOutput(env: NodeJS.ProcessEnv, output: UsageReport, identity: string, today: string, nowMs: number, selected: string): void {
    if (Buffer.byteLength(JSON.stringify(output)) > 65_536) return;
    const cache = join(usageStateDir(env), cacheName(selected));
    const temporary = `${cache}.${process.pid}.tmp`;
    try {
        mkdirSync(usageStateDir(env), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, JSON.stringify({ at: nowMs, date: today, identity, output }), { mode: 0o600 });
        renameSync(temporary, cache);
    } catch { /* a cache that cannot be written is a slower next paint, not an error */ }
}

interface CodexRateLimitResult {
    rateLimitsByLimitId?: Record<string, unknown>;
    rateLimits?: unknown;
}

function codexUsage(env: NodeJS.ProcessEnv): Promise<CodexRateLimitResult | undefined> {
    if (!available('codex', env)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
        const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
        let buffer = '';
        let settled = false;
        let escalation: NodeJS.Timeout | undefined;
        const finish = (value: CodexRateLimitResult | undefined) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                escalation = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1_000);
            }
            resolve(value);
        };
        const timer = setTimeout(() => finish(undefined), 8_000);
        child.once('error', () => finish(undefined));
        child.once('close', () => { if (escalation) clearTimeout(escalation); finish(undefined); });
        child.stdin.on('error', () => finish(undefined));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 64 * 1024) { finish(undefined); return; }
            for (;;) {
                const newline = buffer.indexOf('\n');
                if (newline < 0) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                    const message = JSON.parse(line) as { id?: number; result?: CodexRateLimitResult };
                    if (message.id === 1) child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
                    if (message.id === 2) finish(message.result);
                } catch { /* a non-JSON line is not a rate-limit answer */ }
            }
        });
        child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'muxr', version: '1' } } })}\n`);
    });
}

/** Critical limits first: the limit you are about to hit leads the list, and
 *  inside one limit its windows read shortest first, like every other plan. */
function codexWindowsOrdered(result: CodexRateLimitResult | undefined, nowMs: number): UsageWindowVM[] {
    const limits = Object.values(result?.rateLimitsByLimitId ?? {});
    if (!limits.length && result?.rateLimits !== undefined) limits.push(result.rateLimits);
    // Every window becomes the same view model the other providers use; the
    // rendered shapes below are views of it, never a second parse.
    const groups = limits.flatMap((limit) => {
        if (!isRecord(limit)) return [];
        const rawName = String(limit.limitName ?? limit.limitId ?? 'Codex').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Codex';
        // The plan's own limit is already named by the plan; only a separate
        // limit names itself on its rows.
        const vms = codexWindows([{ ...(rawName.toLowerCase() === 'codex' ? {} : { limitName: rawName }), primary: limit.primary, secondary: limit.secondary }], { nowMs });
        return vms.length === 0 ? [] : [vms.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))];
    });
    const chosen = groups.flatMap((vms) => vms)
        .sort((a, b) => a.percentRemaining - b.percentRemaining)
        .slice(0, 8);
    return groups
        .map((vms, ordinal) => ({ vms: vms.filter((vm) => chosen.includes(vm)), ordinal }))
        .filter(({ vms }) => vms.length > 0)
        .sort((a, b) => Math.min(...a.vms.map((vm) => vm.percentRemaining)) - Math.min(...b.vms.map((vm) => vm.percentRemaining)) || a.ordinal - b.ordinal)
        .flatMap(({ vms }) => vms);
}

/** The identity includes the selected Go credential. Use a bounded KDF rather
 * than a fast hash; the stable domain salt keeps cache comparisons deterministic. */
function cacheIdentity(env: NodeJS.ProcessEnv): string {
    return scryptSync(JSON.stringify({
        config: Object.fromEntries(CONFIG_ENV_KEYS.map((key) => [key, env[key] ?? null])),
        go: goAuthSelection(env),
    }), 'muxr/usage/cache-identity/v4', 32, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex');
}

export interface CollectUsageInput {
    provider?: string;
    /** Re-collect past a still-valid cache (the screen's quiet revalidation). */
    refresh?: boolean;
}

/** The provider whose limits message the selected tab would speak. */
function selectedLimitsMessage(provider: string, claudeVMs: UsageWindowVM[], goVMs: UsageWindowVM[], go: PlanOutcome, zaiVMs: UsageWindowVM[], zaiPlan: PlanOutcome, codex: UsageWindowVM[]): string | undefined {
    if (provider === 'claude' && claudeVMs.length === 0) return 'Claude plan limits unavailable';
    if (provider === 'opencode' && goVMs.length === 0) return go.label;
    if (provider === 'zai' && zaiVMs.length === 0) return zaiPlan.label;
    if (provider === 'codex' && codex.length === 0) return 'Codex plan limits unavailable';
    return NOT_CONNECTED_MESSAGE;
}

/** Collections in flight, keyed exactly as the cache is: identity, local date
 *  and selected tab. */
const inFlight = new Map<string, Promise<UsageReport>>();

export async function collectUsage(input: CollectUsageInput = {}, env: NodeJS.ProcessEnv = process.env): Promise<UsageReport> {
    const requested = (input.provider ?? '').slice(0, MAX_PROVIDER_INPUT);
    const selected = Object.hasOwn(AGENTS, requested) ? requested : '';
    // One captured instant for the whole response: two reads either side of local
    // midnight would label one provider's day with another day's window.
    const NOW = nowDate(env);
    const TODAY = localDate(NOW);
    const identity = cacheIdentity(env);
    const cached = input.refresh === true ? undefined : cachedOutput(env, identity, TODAY, NOW.getTime(), selected);
    if (cached !== undefined) {
        return withAge(cached.stale ? { ...cached.output, stale: true } : cached.output, NOW.getTime());
    }
    // A cold cache asked for by several readers at once -- the Home card's
    // follow-ups, the Usage screen's revalidation, another screen or device --
    // costs one collection, not one per reader. Every waiter gets the same
    // answer or the same rejection; the entry is cleared however it settles.
    const key = `${identity}\u0000${TODAY}\u0000${selected}`;
    const running = inFlight.get(key);
    if (running !== undefined) return running;
    let collection: Promise<UsageReport>;
    collection = collectFresh(selected, NOW, TODAY, identity, env).finally(() => {
        if (inFlight.get(key) === collection) inFlight.delete(key);
    });
    inFlight.set(key, collection);
    return collection;
}

/** The collection itself, once the caller knows the cache is cold. The instant,
 *  the provider tab and the cache identity are fixed for the whole payload. */
async function collectFresh(selected: string, NOW: Date, TODAY: string, identity: string, env: NodeJS.ProcessEnv): Promise<UsageReport> {
    const PERIODS = windowPeriods(NOW);
    // Codex limits load every time: the home card lists them whatever tab the
    // details screen last showed.
    const [{ range, failure: ccusageFailure }, codex, local] = await Promise.all([
        ccusageRange(env), codexUsage(env).then((result) => codexWindowsOrdered(result, Date.now())),
        collectLocalUsage(PERIODS, NOW.getTime(), env),
    ]);
    const agents = byAgent(range, PERIODS);
    const latest = new Map<string, number>();
    const sessions = range?.session;
    for (const row of Array.isArray(sessions) ? sessions : []) {
        const session = isRecord(row) ? row : {};
        const agent = String(session.agent ?? '');
        const total = session.totalTokens;
        if (!CCUSAGE_AGENTS.has(agent) || typeof total !== 'number' || !(total > 0)) continue;
        const at = Date.parse(String((isRecord(session.metadata) ? session.metadata.lastActivity : undefined) ?? ''));
        if (Number.isFinite(at) && at <= NOW.getTime()) latest.set(agent, Math.max(latest.get(agent) ?? 0, at));
    }
    // OMP and Pi are accounted from their own transcripts, so ccusage's rows for
    // them are the duplicated ones this collector replaces. A collection that
    // timed out, crashed or answered with nothing leaves no total to fall back to.
    const reports: Record<string, LocalAgentReport> = { ...local };
    for (const agent of ['omp', 'pi']) {
        const report = reports[agent];
        if (!isRecord(report) || !Array.isArray(report.rows) && report.unavailable !== true) {
            reports[agent] = { unavailable: true, reason: 'Local activity could not be measured · reopen Usage in a minute' };
        }
    }
    for (const [agent, report] of Object.entries(reports)) {
        if (report === undefined) continue;
        if (Number.isFinite(report.latest) && (report.latest as number) <= NOW.getTime()) latest.set(agent, report.latest as number);
        if (report.unavailable) { agents.delete(agent); continue; }
        if (!report.rows) continue;
        const days: UsageDayRow[] = PERIODS.map((period) => ({ period, row: undefined }));
        for (const aggregate of report.rows) {
            if (!Number.isSafeInteger(aggregate.totalTokens) || (aggregate.totalTokens ?? 0) < 0) continue;
            const day = days.find((candidate) => candidate.period === aggregate.period);
            if (!day) continue;
            day.row ??= { totalTokens: 0, totalCost: 0, modelBreakdowns: [] };
            day.row.totalTokens += aggregate.totalTokens ?? 0;
            day.row.totalCost = Number.isFinite(day.row.totalCost) && Number.isFinite(aggregate.totalCost)
                ? (day.row.totalCost as number) + (aggregate.totalCost as number)
                : undefined;
            day.row.modelBreakdowns.push(aggregate);
        }
        agents.set(agent, days);
    }
    // A connected plan with no collector of its own is measured from the local
    // worker records that run it: Pi transcripts name every model per turn, so
    // the Z.ai tab aggregates its own slice instead of reporting dashes.
    const zaiConnected = zaiToken(env) !== undefined;
    const zaiModelIds = zaiConnected ? zaiModels(env) : new Set<string>();
    const zaiLocal = zaiConnected ? localActivityForModels(reports.pi, zaiModelIds, PERIODS) : undefined;
    if (zaiLocal) {
        agents.set('zai', zaiLocal.days);
        if (Number.isFinite(zaiLocal.latest) && (zaiLocal.latest as number) <= NOW.getTime()) latest.set('zai', zaiLocal.latest as number);
        reports.zai = {
            rows: zaiLocal.days.flatMap((day) => day.row?.modelBreakdowns ?? []),
            ...(zaiLocal.latest === undefined ? {} : { latest: zaiLocal.latest }),
        };
    }
    const installed = Object.entries(AGENT_COMMANDS).filter(([agent, command]) => installedAgent(agent, command, env));
    // A tab means real integration: measured activity this week, or a connected
    // plan/account. Installed-but-idle CLIs are neither, so they earn no tab;
    // a deep link to one falls back to the default tab. A failed collection is
    // not a detection: an uninstalled provider's placeholder earns no tab (so a
    // machine with nothing measured or connected reaches the no-provider state).
    // An explicit selection still resolves to its own collector report, so a
    // chosen provider whose collection just failed shows its honest unavailable
    // notice instead of quietly borrowing another provider's numbers.
    const planCandidates: [string, boolean][] = [
        ['claude', claudeCredentials(env) !== undefined], ['opencode', goConnected(env)], ['zai', zaiToken(env) !== undefined],
    ];
    const planConnected = planCandidates.flatMap(([agent, connected]) => (connected ? [agent] : []));
    const providerIds = [...new Set([
        ...agents.keys(),
        ...latest.keys(),
        ...Object.keys(reports).filter((agent) => reports[agent]?.unavailable !== true || installed.some(([name]) => name === agent)),
        ...planConnected,
        ...(codex.length > 0 ? ['codex'] : []),
    ])]
        .sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0) || (AGENTS[a] ?? a).localeCompare(AGENTS[b] ?? b));
    const provider = selected !== '' && (providerIds.includes(selected) || reports[selected] !== undefined)
        ? selected
        : providerIds[0] ?? '';
    const activitySupported = CCUSAGE_AGENTS.has(provider) || provider === 'omp' || provider === 'zai';
    const localReport = reports[provider];
    let activityFailure = ccusageFailure;
    if (localReport?.rows) activityFailure = undefined;
    if (localReport?.unavailable) activityFailure = localReport.reason ?? 'Local activity unavailable';
    // Z.ai is measured from Pi's records, so ccusage's health says nothing about
    // this tab; only whether its models could be attributed does.
    if (provider === 'zai' && zaiConnected && zaiModelIds.size === 0) activityFailure = 'Local activity unavailable for this provider';
    else if (provider === 'zai' && zaiConnected && reports.pi?.unavailable) activityFailure = reports.pi.reason ?? 'Local activity unavailable';
    else if (provider === 'zai' && zaiConnected) activityFailure = undefined;
    const activityAvailable = activitySupported && activityFailure === undefined;
    // Only failures speak on the screen now (a notice inside the Today card).
    const days = agents.get(provider) ?? PERIODS.map((period) => ({ period, row: undefined }));
    const totals = activityTotals(days);
    const { today, tokensToday, tokensWeek, costToday, costWeek } = totals;
    // Connected plans load whatever tab is on screen: a machine-level view
    // (the default tab, the Home card) must see every real window, not just
    // the selected tab's. An explicitly selected tab still collects its own
    // source even when disconnected, so its honest unavailable message stands.
    const skipPlan: PlanOutcome = { label: '' };
    const [claudeRaw, go, zaiPlan] = await Promise.all([
        planConnected.includes('claude') || provider === 'claude' ? claudePlanLimits(env) : Promise.resolve(undefined),
        planConnected.includes('opencode') || provider === 'opencode' ? goPlanLimits(env) : Promise.resolve(skipPlan),
        planConnected.includes('zai') || provider === 'zai' ? zaiPlanLimits(env) : Promise.resolve(skipPlan),
    ]);
    // One transform per source, one view model for the screen: everything below
    // renders from these, never from a provider payload.
    const nowMs = Date.now();
    const claudeVMs = claudeWindows(claudeRaw, { nowMs });
    const zaiVMs = zaiPlan.vms ?? [];
    const goVMs = go.vms ?? [];
    const selectedVMs = selectedWindows(provider, claudeVMs, codex, zaiVMs, goVMs);
    // Every plan collector's real windows, most urgent first: the borrow rule
    // and the Home card's connected strip read the same list, so a machine-level
    // view and a per-tab view can never disagree about which plan is tightest.
    const planShapes = [
        { id: 'claude', plan: PLAN_PROVIDERS.claude, vms: claudeVMs },
        { id: 'codex', plan: PLAN_PROVIDERS.codex, vms: codex },
        { id: 'opencode', plan: PLAN_PROVIDERS.opencode, vms: goVMs },
        { id: 'zai', plan: PLAN_PROVIDERS.zai, vms: zaiVMs },
    ].flatMap(({ id, plan, vms }) => (vms.length === 0 ? [] : [{ id, plan, vms, used: tightestWindow(vms)!.percentUsed }]))
        .sort((a, b) => b.used - a.used);
    // One quiet line when the plan has nothing to card; the message is the
    // provider-specific truth (not connected, reconnect, unavailable).
    const noProvidersFields = providerIds.length === 0
        ? { noProviders: 'Run a coding agent on this computer or connect a plan.', noProvidersTitle: 'No supported providers detected' }
        : {};
    // A selection without its own plan collector (pi, omp, gemini, ...) borrows
    // the tightest connected plan, so the default view answers with a real
    // window instead of a machine-level "not connected" that is false whenever
    // any plan is connected. A plan tab keeps speaking for itself: its own
    // unavailable message beats another plan's numbers.
    const borrowed = (PLAN_PROVIDERS[provider] === undefined && selectedVMs.length === 0) ? planShapes[0] : undefined;
    const limitsVMs = borrowed !== undefined ? borrowed.vms : selectedVMs;
    const limitsPlan = borrowed !== undefined ? borrowed.plan : PLAN_PROVIDERS[provider];
    const limitsMessage = (providerIds.length > 0 && limitsVMs.length === 0)
        ? selectedLimitsMessage(provider, claudeVMs, goVMs, go, zaiVMs, zaiPlan, codex)
        : undefined;
    const connected: UsageConnectedProvider[] = planShapes.map(({ id, plan, vms }) => ({
        id,
        label: TAB_LABELS[id] ?? AGENTS[id] ?? id,
        glyph: id,
        ...(plan === undefined ? {} : { plan }),
        windows: limitsPayload(vms, { ...(plan === undefined ? {} : { plan }) }).windows,
    }));
    const output: UsageReport = {
        providers: providerIds.map((agent) => ({ id: agent, label: TAB_LABELS[agent] ?? AGENTS[agent] ?? agent, glyph: agent })),
        provider,
        providerName: AGENTS[provider] ?? 'Usage',
        ...noProvidersFields,
        ...(activityFailure === undefined ? {} : { activityNotice: activityFailure }),
        todayTokens: activityTokens(tokensToday, activityAvailable),
        // A measured day with no activity cost nothing; a measured row whose cost
        // was never recorded is unknown, and a dash is the only honest figure.
        todayCost: activityCost(costToday, today !== undefined, activityAvailable),
        modelSeries: modelSeries(today),
        weekTokens: activityTokens(tokensWeek, activityAvailable),
        weekCost: (activityAvailable && costWeek !== undefined) ? money(costWeek) ?? '—' : '—',
        weekSeries: (activityAvailable ? days : []).map(({ period, row }): UsageSeriesPoint => ({
            label: dayLabel(period), value: row?.totalTokens ?? 0, valueLabel: tokens(row?.totalTokens ?? 0) ?? '0', detail: period,
        })),
        capturedAt: NOW.toISOString(),
        windowPeriods: PERIODS,
        // The normalized view model behind every rendered rate-limit shape.
        windows: limitsVMs,
        limits: limitsPayload(limitsVMs, {
            ...(limitsPlan === undefined ? {} : { plan: limitsPlan }),
            ...(limitsMessage === undefined ? {} : { message: limitsMessage }),
        }),
        // One compact entry per provider with real quota windows, most urgent
        // first: the Home card's strip reads this instead of re-deriving every
        // tab's state from a payload that answers for one tab.
        ...(connected.length === 0 ? {} : { connected }),
    };
    // Never pin a failure or a fallback provider under the requested key: one
    // blocked read would otherwise own the screen for the whole TTL. The gate
    // is the selected tab's own health: another provider's blocked limits must
    // not stop this tab from caching, or every visit pays the full rescan. A
    // stale paint never persists its own flag: the saved payload stays clean.
    const limitsUnavailable = goUnavailable(provider, goVMs) || claudeUnavailable(provider, claudeVMs)
        || zaiUnavailable(provider, zaiVMs) || codexUnavailable(provider, codex);
    if (activityFailure === undefined && reports[provider]?.unavailable !== true && !limitsUnavailable && (selected === '' || selected === output.provider)) {
        saveOutput(env, output, identity, TODAY, NOW.getTime(), selected);
    }
    return withAge(output, NOW.getTime());
}

/** The age of the reading, by the host's clock, so every reader can apply its
 *  own freshness window to one number rather than the coarser cache flag. */
function withAge(output: UsageReport, nowMs: number): UsageReport {
    const capturedAt = Date.parse(output.capturedAt ?? '');
    if (!Number.isFinite(capturedAt)) return output;
    return { ...output, ageSeconds: Math.max(0, Math.round((nowMs - capturedAt) / 1_000)) };
}

function selectedWindows(provider: string, claudeVMs: UsageWindowVM[], codex: UsageWindowVM[], zaiVMs: UsageWindowVM[], goVMs: UsageWindowVM[]): UsageWindowVM[] {
    if (provider === 'claude') return claudeVMs;
    if (provider === 'codex') return codex;
    if (provider === 'zai') return zaiVMs;
    if (provider === 'opencode') return goVMs;
    return [];
}

/** A measured figure, or the dash that says this tab could not be measured. */
function activityTokens(value: number, available: boolean): string {
    if (!available) return '—';
    return tokens(value) ?? '—';
}

function activityCost(cost: number | undefined, measured: boolean, available: boolean): string {
    if (!available) return '—';
    // A measured day with no activity cost nothing; a measured row whose cost
    // was never recorded is unknown, and a dash is the only honest figure.
    if (!measured) return '$0.00';
    return money(cost ?? Number.NaN) ?? '—';
}

function goUnavailable(provider: string, goVMs: UsageWindowVM[]): boolean {
    return provider === 'opencode' && goVMs.length === 0;
}

function claudeUnavailable(provider: string, claudeVMs: UsageWindowVM[]): boolean {
    return provider === 'claude' && claudeVMs.length === 0;
}

function zaiUnavailable(provider: string, zaiVMs: UsageWindowVM[]): boolean {
    return provider === 'zai' && zaiVMs.length === 0;
}

function codexUnavailable(provider: string, codex: UsageWindowVM[]): boolean {
    return provider === 'codex' && codex.length === 0;
}
