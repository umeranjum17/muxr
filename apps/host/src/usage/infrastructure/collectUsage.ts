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

/** The Claude account Claude Code is signed in to, re-read on every call so
 *  Claude Code's own renewal is picked up the next time it runs. muxr never
 *  renews these credentials itself: an expired token only means Claude is not
 *  read until Claude Code renews it, while its last good reading stands. */
function claudeAuth(env: NodeJS.ProcessEnv): { token: string; expired: boolean; account: string } | undefined {
    const stored = readJson(join(claudeConfigDir(env), '.credentials.json'), 64 * 1024)?.value;
    const credentials = isRecord(stored) && isRecord(stored.claudeAiOauth) ? stored.claudeAiOauth : undefined;
    const token = credentials?.accessToken;
    if (credentials === undefined || typeof token !== 'string' || token === '' || token.length > 16 * 1024) return undefined;
    // Claude Code keeps the signed-in account beside its config: in the config
    // directory when one is set, otherwise in the home directory.
    const configFile = env.CLAUDE_CONFIG_DIR?.trim()
        ? join(env.CLAUDE_CONFIG_DIR.trim(), '.claude.json')
        : join(env.HOME?.trim() || homedir(), '.claude.json');
    const config = readJson(configFile, 4 * 1024 * 1024)?.value;
    const oauthAccount = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : undefined;
    let account = token;
    if (typeof credentials.accountUuid === 'string') account = credentials.accountUuid;
    else if (typeof oauthAccount?.accountUuid === 'string') account = oauthAccount.accountUuid;
    const expiresAt = credentials.expiresAt;
    return { token, expired: typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= Date.now(), account };
}

/** Anthropic answers its usage endpoint for Claude Code's own client and
 *  rate-limits any other caller on sight, so the read identifies itself the
 *  way Claude Code does. */
const CLAUDE_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.202' };
/** A rate-limited provider is not asked again before this; its last good
 *  reading stands in meanwhile. */
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const backoffUntil = new Map<string, number>();

interface ProviderAnswer {
    /** The HTTP status, absent when no answer arrived at all. */
    status?: number;
    body?: string;
}

/** One bounded provider read. A failure is not retried here: the last good
 *  reading stands and the next collection asks again. A 429 backs the
 *  provider off, so its rate limit is never spent on us. */
async function providerGet(provider: string, url: string, headers: Record<string, string>): Promise<ProviderAnswer> {
    if ((backoffUntil.get(provider) ?? 0) > Date.now()) return { status: 429 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, redirect: 'error', signal: controller.signal });
        if (response.status === 429) {
            const seconds = Number(response.headers.get('retry-after'));
            backoffUntil.set(provider, Date.now() + Math.max(RATE_LIMIT_BACKOFF_MS, Number.isFinite(seconds) ? seconds * 1_000 : 0));
        }
        if (!response.ok || response.body === null) {
            controller.abort();
            return { status: response.status };
        }
        let body = '';
        for await (const chunk of response.body) {
            body += Buffer.from(chunk).toString('utf8');
            if (Buffer.byteLength(body) > 64 * 1024) { controller.abort(); return { status: response.status }; }
        }
        return { status: response.status, body };
    } catch {
        return {};
    } finally { clearTimeout(timer); }
}

function parsed(body: string | undefined): unknown {
    try { return body === undefined ? undefined : JSON.parse(body) as unknown; } catch { return undefined; }
}

async function claudePlanLimits(env: NodeJS.ProcessEnv): Promise<unknown> {
    const snapshot = readJson(join(claudeConfigDir(env), 'last-statusline-input.json'), 64 * 1024);
    const snapshotAge = snapshot === undefined ? undefined : Date.now() - snapshot.modified;
    if (snapshot !== undefined && snapshotAge !== undefined && snapshotAge >= 0 && snapshotAge < 5 * 60_000) {
        if (claudeWindows(snapshot.value, { nowMs: Date.now() }).length > 0) return snapshot.value;
    }
    const auth = claudeAuth(env);
    if (auth === undefined || auth.expired) return undefined;
    const answer = await providerGet('claude', 'https://api.anthropic.com/api/oauth/usage', { authorization: `Bearer ${auth.token}`, ...CLAUDE_HEADERS });
    return answer.status === 200 ? parsed(answer.body) : undefined;
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
    /** The provider's own payload, kept so a later failed read can stand on it. */
    raw?: unknown;
    vms?: UsageWindowVM[];
    label: string;
}

async function goPlanLimits(env: NodeJS.ProcessEnv): Promise<PlanOutcome> {
    if (!goConnected(env)) return { label: 'OpenCode Go limits unavailable · connect your Go account in OpenCode' };
    const { auth } = goAuthSelection(env);
    const { status, body } = await providerGet('opencode', 'https://opencode.ai/zen/go/v1/usage', { authorization: `Bearer ${auth?.key as string}` });
    if (status === 401) return { label: 'OpenCode Go authentication unavailable · reconnect in OpenCode' };
    if (status === 403) return { label: 'OpenCode Go subscription unavailable for this account' };
    if (status !== 200) return { label: 'OpenCode Go limits unavailable · try again shortly' };
    const raw = (parsed(body) as { usage?: unknown } | undefined)?.usage;
    const vms = goWindows(raw, { nowMs: Date.now() });
    if (vms.length === 0) return { label: 'OpenCode Go limits unavailable · incomplete response' };
    return { raw, vms, label: 'OpenCode Go plan usage' };
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
    const { status, body } = await providerGet('zai', 'https://api.z.ai/api/monitor/usage/quota/limit', { authorization: `Bearer ${token}` });
    if (status === 401) return { label: 'Z.ai authentication unavailable · reconnect in Pi' };
    if (status === 403) return { label: 'Z.ai coding plan unavailable for this account' };
    if (status !== 200) return { label: 'Z.ai limits unavailable · try again shortly' };
    const answer = parsed(body) as { success?: unknown; data?: { limits?: unknown } } | undefined;
    if (answer?.success === false) return { label: 'Z.ai coding plan unavailable for this account' };
    const raw = answer?.data?.limits;
    const vms = zaiWindows(raw, { nowMs: Date.now() });
    if (vms.length === 0) return { label: 'Z.ai limits unavailable · incomplete response' };
    return { raw, vms, label: 'Z.ai plan usage' };
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

/** Everything one collection measured, before any tab borrows it: every plan's
 *  windows, every agent's local activity rows, the tab list and the connected
 *  strip. One answer per machine per moment, which the Home card's compact
 *  payload and every Usage tab project from -- never one collection each. */
interface RawCollection {
    /** The collection's one captured instant. */
    at: number;
    capturedAt: string;
    /** The oldest plan reading shown, when a last good reading stood in. */
    readingsFrom: number;
    periods: string[];
    plans: Partial<Record<PlanId, UsageWindowVM[]>>;
    /** Every plan collector's real windows, most urgent first. */
    shapes: ReturnType<typeof planStrip>['planShapes'];
    connected: UsageConnectedProvider[];
    providerIds: string[];
    /** Measured local activity per agent, in the report's own day shape. */
    agents: Record<string, UsageDayRow[]>;
    reports: Record<string, LocalAgentReport>;
    /** Why local activity could not be measured, when it could not. */
    ccusageFailure?: string;
    /** The Z.ai attribution facts its activity rules read. */
    zaiConnected: boolean;
    zaiModelCount: number;
    /** The plan collectors' own words for a plan they could not read. */
    goLabel: string;
    zaiLabel: string;
    /** A successful plan read or local activity scan produced this answer. */
    storedFresh: boolean;
}

const completed = new Map<string, RawCollection>();

function cacheName(selected: string): string {
    return `usage-v2-${selected === '' ? 'all' : selected}.json`;
}

function cachedOutput(env: NodeJS.ProcessEnv, identity: string, today: string, nowMs: number, selected: string): UsageReport | undefined {
    const saved = readJson(join(usageStateDir(env), cacheName(selected)), 128 * 1024)?.value;
    if (!isRecord(saved) || saved.identity !== identity || saved.date !== today || !isRecord(saved.output)
        || !Array.isArray(saved.output.providers) || typeof saved.at !== 'number' || nowMs - saved.at < 0) return undefined;
    const output = saved.output as unknown as UsageReport;
    return withAge({ ...output, ...(nowMs - saved.at >= PLAN_MIN_READ_MS ? { stale: true as const } : {}) }, nowMs);
}

function saveOutput(env: NodeJS.ProcessEnv, output: UsageReport, identity: string, today: string, nowMs: number, selected: string): void {
    const body = JSON.stringify({ at: nowMs, date: today, identity, output });
    if (Buffer.byteLength(body) > 65_536) return;
    const cache = join(usageStateDir(env), cacheName(selected));
    const temporary = `${cache}.${process.pid}.tmp`;
    try {
        mkdirSync(usageStateDir(env), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, body, { mode: 0o600 });
        renameSync(temporary, cache);
    } catch { /* an unwritten cache only makes the next paint slower */ }
}

type PlanId = 'claude' | 'codex' | 'opencode' | 'zai';
const PLAN_IDS: PlanId[] = ['claude', 'codex', 'opencode', 'zai'];
/** A reading this recent is the answer: asking the provider again sooner
 *  spends its rate limit and, on a loaded host, a process spawn for nothing. */
const PLAN_MIN_READ_MS = 60_000;
/** The oldest reading worth painting while a collection runs: after a restart
 *  the card opens on it and the collection replaces it seconds later. */
const PLAN_LAST_KNOWN_MS = 24 * 60 * 60_000;

interface PlanReading { at: number; raw: unknown; account: string }
type PlanReadings = Partial<Record<PlanId, PlanReading>>;

/** Account fingerprints already derived: the KDF is deliberately slow, and a
 *  collection asks for every provider's more than once. */
const fingerprints = new Map<string, string>();

function accountFingerprint(id: PlanId, value: string): string {
    const key = `${id}\u0000${value}`;
    let fingerprint = fingerprints.get(key);
    if (fingerprint === undefined) {
        fingerprint = scryptSync(value, `muxr/usage/account/${id}`, 32, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex');
        if (fingerprints.size >= 32) fingerprints.clear();
        fingerprints.set(key, fingerprint);
    }
    return fingerprint;
}

/** Whose reading each provider's would be now, from the same configuration
 *  the read itself uses. A stored reading is only ever shown for the account
 *  it was read from, one provider at a time: switching one account never costs
 *  another provider its reading, and a changed PATH or time zone costs none. */
function planAccounts(env: NodeJS.ProcessEnv): Partial<Record<PlanId, string>> {
    const codexAuth = readJson(join(env.CODEX_HOME || join(env.HOME?.trim() || homedir(), '.codex'), 'auth.json'), 64 * 1024)?.value;
    const tokens = isRecord(codexAuth) && isRecord(codexAuth.tokens) ? codexAuth.tokens : undefined;
    // The account id is stable across Codex's own token rotation; a login
    // without one (an API key) is the one account this CODEX_HOME has.
    const codex = typeof tokens?.account_id === 'string' ? tokens.account_id : 'codex-home';
    const accounts: Partial<Record<PlanId, string>> = {};
    const selected: Partial<Record<PlanId, unknown>> = {
        claude: claudeAuth(env)?.account, codex,
        opencode: goConnected(env) ? goAuthSelection(env).auth?.key : undefined,
        zai: zaiToken(env),
    };
    for (const id of PLAN_IDS) {
        const value = selected[id];
        if (typeof value === 'string' && value !== '' && value.length <= 16 * 1024) accounts[id] = accountFingerprint(id, value);
    }
    return accounts;
}

/** The last good reading of every plan, per provider, on disk: what a failed
 *  read stands on and what a restarted host paints first. */
function readPlans(env: NodeJS.ProcessEnv, accounts: Partial<Record<PlanId, string>>): PlanReadings {
    const saved = readJson(join(usageStateDir(env), 'plans-v1.json'), 256 * 1024)?.value;
    if (!isRecord(saved) || !isRecord(saved.plans)) return {};
    const plans: PlanReadings = {};
    for (const id of PLAN_IDS) {
        const reading = saved.plans[id];
        if (isRecord(reading) && accounts[id] !== undefined && reading.account === accounts[id] && Number.isFinite(reading.at)) {
            plans[id] = { at: reading.at as number, raw: reading.raw, account: accounts[id] };
        }
    }
    return plans;
}

/** Merge this collection's new readings into the file: another collection
 *  running beside it may have landed a reading this one did not. */
function savePlans(env: NodeJS.ProcessEnv, updates: PlanReadings, accounts: Partial<Record<PlanId, string>>): void {
    const path = join(usageStateDir(env), 'plans-v1.json');
    const temporary = `${path}.${process.pid}.tmp`;
    try {
        const plans = readPlans(env, accounts);
        for (const id of PLAN_IDS) {
            const next = updates[id];
            if (next !== undefined && next.account === accounts[id] && next.at >= (plans[id]?.at ?? -Infinity)) plans[id] = next;
        }
        const body = JSON.stringify({ plans });
        if (Buffer.byteLength(body) > 256 * 1024) return;
        mkdirSync(usageStateDir(env), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, body, { mode: 0o600 });
        renameSync(temporary, path);
    } catch { /* an unwritten reading only means the next failure has nothing to stand on */ }
}

/** A plan's windows from its provider's own payload, as of `nowMs`. */
function planWindows(id: PlanId, raw: unknown, nowMs: number): UsageWindowVM[] {
    if (raw === undefined) return [];
    if (id === 'claude') return claudeWindows(raw, { nowMs });
    if (id === 'codex') return codexWindowsOrdered(raw as CodexRateLimitResult, nowMs);
    if (id === 'opencode') return goWindows(raw, { nowMs });
    return zaiWindows(raw, { nowMs });
}

/** Whether a plan's account is still there to be read: a stored reading never
 *  outlives the credentials it was read with. */
function planStillConnected(id: PlanId, env: NodeJS.ProcessEnv): boolean {
    if (id === 'claude') return claudeAuth(env) !== undefined;
    if (id === 'codex') return available('codex', env);
    if (id === 'opencode') return goConnected(env);
    return zaiToken(env) !== undefined;
}

/** Every plan's windows, most urgent first, and the Home card's strip of them. */
function planStrip(vmsById: Partial<Record<PlanId, UsageWindowVM[]>>) {
    const planShapes = PLAN_IDS.flatMap((id) => {
        const vms = vmsById[id] ?? [];
        return vms.length === 0 ? [] : [{ id, plan: PLAN_PROVIDERS[id]!, vms, used: tightestWindow(vms)!.percentUsed }];
    }).sort((a, b) => b.used - a.used);
    const connected: UsageConnectedProvider[] = planShapes.map(({ id, plan, vms }) => ({
        id, label: TAB_LABELS[id] ?? AGENTS[id] ?? id, glyph: id, plan, windows: limitsPayload(vms, { plan }).windows,
    }));
    return { planShapes, connected };
}

/** What the card can paint before any collection answers: the last good
 *  reading of every still-connected plan, recomputed for now. */
export function lastKnownPlans(env: NodeJS.ProcessEnv = process.env): Pick<UsageReport, 'windows' | 'limits' | 'connected' | 'capturedAt' | 'readingsFrom'> | undefined {
    const nowMs = Date.now();
    const at = nowDate(env).getTime();
    const accounts = planAccounts(env);
    const stored = readPlans(env, accounts);
    const vmsById: Partial<Record<PlanId, UsageWindowVM[]>> = {};
    let oldest = Number.POSITIVE_INFINITY;
    let newest = 0;
    for (const id of PLAN_IDS) {
        const reading = stored[id];
        if (reading === undefined || at - reading.at > PLAN_LAST_KNOWN_MS || !planStillConnected(id, env)) continue;
        const vms = planWindows(id, reading.raw, nowMs);
        if (vms.length === 0) continue;
        vmsById[id] = vms;
        oldest = Math.min(oldest, reading.at);
        newest = Math.max(newest, reading.at);
    }
    const { planShapes, connected } = planStrip(vmsById);
    const tightest = planShapes[0];
    if (tightest === undefined) return undefined;
    return {
        windows: tightest.vms,
        limits: limitsPayload(tightest.vms, { plan: tightest.plan }),
        connected,
        capturedAt: new Date(newest).toISOString(),
        readingsFrom: new Date(oldest).toISOString(),
    };
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
        // A loaded host can take most of this just to start the app server;
        // nothing waits on it any more, since the last reading stands meanwhile.
        const timer = setTimeout(() => finish(undefined), 20_000);
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
    report?: boolean;
    /** Re-collect past a still-valid cache (the screen's quiet revalidation). */
    refresh?: boolean;
}

/** The provider whose limits message the selected tab would speak. */
function selectedLimitsMessage(provider: string, claudeVMs: UsageWindowVM[], goVMs: UsageWindowVM[], goLabel: string, zaiVMs: UsageWindowVM[], zaiLabel: string, codex: UsageWindowVM[]): string | undefined {
    if (provider === 'claude' && claudeVMs.length === 0) return 'Claude plan limits unavailable';
    if (provider === 'opencode' && goVMs.length === 0) return goLabel;
    if (provider === 'zai' && zaiVMs.length === 0) return zaiLabel;
    if (provider === 'codex' && codex.length === 0) return 'Codex plan limits unavailable';
    return NOT_CONNECTED_MESSAGE;
}

/** Collections in flight, keyed by identity and local date: the card's ask and
 *  any tab's ask join the one collection instead of racing a second one. */
const inFlight = new Map<string, Promise<RawCollection>>();

export async function collectUsage(input: CollectUsageInput = {}, env: NodeJS.ProcessEnv = process.env): Promise<UsageReport> {
    const requested = (input.provider ?? '').slice(0, MAX_PROVIDER_INPUT);
    const selected = Object.hasOwn(AGENTS, requested) ? requested : '';
    // One captured instant for the whole response: two reads either side of local
    // midnight would label one provider's day with another day's window.
    const NOW = nowDate(env);
    const TODAY = localDate(NOW);
    const accounts = planAccounts(env);
    const identity = `${cacheIdentity(env)}:${JSON.stringify(accounts)}`;
    // A reader that did not force reuses the day's completed collection.
    const key = `${identity}\u0000${TODAY}`;
    if (input.refresh !== true) {
        const cached = completed.get(key);
        if (cached !== undefined) return project(cached, selected, NOW.getTime(), NOW.getTime() - cached.at >= PLAN_MIN_READ_MS);
        if (input.report) {
            const saved = cachedOutput(env, identity, TODAY, NOW.getTime(), selected);
            if (saved !== undefined) return saved;
        }
    }
    // Concurrent card and tab reads join one collection.
    let collection = inFlight.get(key);
    if (collection === undefined) {
        collection = collectFresh(NOW, accounts, env).then((raw) => {
            if (raw.storedFresh) completed.set(key, raw);
            return raw;
        }).finally(() => { inFlight.delete(key); });
        inFlight.set(key, collection);
    }
    const raw = await collection;
    const output = project(raw, selected, NOW.getTime());
    const limitsUnavailable = (selected === 'claude' && raw.plans.claude?.length === 0)
        || (selected === 'codex' && raw.plans.codex?.length === 0)
        || (selected === 'opencode' && raw.plans.opencode?.length === 0)
        || (selected === 'zai' && raw.plans.zai?.length === 0);
    if (input.report && raw.storedFresh && output.activityNotice === undefined && raw.reports[output.provider]?.unavailable !== true && !limitsUnavailable
        && (selected === '' || selected === output.provider)) {
        saveOutput(env, output, identity, TODAY, NOW.getTime(), selected);
    }
    return output;
}

/** The collection itself, once the caller knows the cache is cold. It measures
 *  the whole machine -- every plan, every agent's local activity -- once; which
 *  tab asked is a projection concern and never reaches this code. The instant
 *  and the cache identity are fixed for the whole payload. */
async function collectFresh(NOW: Date, accounts: Partial<Record<PlanId, string>>, env: NodeJS.ProcessEnv): Promise<RawCollection> {
    const PERIODS = windowPeriods(NOW);
    const skipPlan: PlanOutcome = { label: '' };
    // Every connected plan is read alongside local activity, not after it:
    // under load the activity scan is the long pole, and the plans are what
    // the Home card waits on. Codex limits load every time: the home card
    // lists them whatever tab the details screen last showed.
    const stored = readPlans(env, accounts);
    const recent = (id: PlanId) => NOW.getTime() - (stored[id]?.at ?? Number.NEGATIVE_INFINITY) < PLAN_MIN_READ_MS;
    const planConnected: string[] = (['claude', 'opencode', 'zai'] as const).filter((id) => planStillConnected(id, env));
    // Connected plans read moments ago answer from their last reading; the
    // other collectors still provide their own unavailable labels.
    const readEarly = <T,>(id: PlanId, read: () => Promise<T>, skip: T): Promise<T> | undefined => {
        if (!planConnected.includes(id)) return undefined;
        return recent(id) ? Promise.resolve(skip) : read();
    };
    const early = {
        claude: readEarly<unknown>('claude', () => claudePlanLimits(env), undefined) ?? Promise.resolve(undefined),
        opencode: readEarly('opencode', () => goPlanLimits(env), skipPlan) ?? goPlanLimits(env),
        zai: readEarly('zai', () => zaiPlanLimits(env), skipPlan) ?? zaiPlanLimits(env),
    };
    const [{ range, failure: ccusageFailure }, codexRaw, local] = await Promise.all([
        ccusageRange(env), recent('codex') ? Promise.resolve(undefined) : codexUsage(env), collectLocalUsage(PERIODS, NOW.getTime(), env),
    ]);
    // Per-provider isolation: a plan whose read failed this time -- a
    // timeout, a refusal, a rate limit -- or that was read moments ago keeps
    // its last good reading, aged honestly through `readingsFrom`, instead of
    // vanishing from the card.
    const readings: PlanReadings = { ...stored };
    let readingsFrom = NOW.getTime();
    const windowsOf = (id: PlanId, raw: unknown): UsageWindowVM[] => {
        const nowMs = Date.now();
        const vms = planWindows(id, raw, nowMs);
        if (vms.length > 0) {
            const account = accounts[id];
            if (account !== undefined) readings[id] = { at: NOW.getTime(), raw, account };
            return vms;
        }
        const last = stored[id];
        if (last === undefined || NOW.getTime() - last.at > PLAN_LAST_KNOWN_MS || !planStillConnected(id, env)) return [];
        readingsFrom = Math.min(readingsFrom, last.at);
        return planWindows(id, last.raw, nowMs);
    };
    const codex = windowsOf('codex', codexRaw);
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
    const providerIds = [...new Set([
        ...agents.keys(),
        ...latest.keys(),
        ...Object.keys(reports).filter((agent) => reports[agent]?.unavailable !== true || installed.some(([name]) => name === agent)),
        ...planConnected,
        ...(codex.length > 0 ? ['codex'] : []),
    ])]
        .sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0) || (AGENTS[a] ?? a).localeCompare(AGENTS[b] ?? b));
    // Connected plans load whatever tab is on screen: a machine-level view
    // (the default tab, the Home card) must see every real window, not just
    // the selected tab's. A disconnected plan's collector answers with its
    // own honest label, so that label is on hand for whichever tab asks.
    const [claudeRaw, go, zaiPlan] = await Promise.all([early.claude, early.opencode, early.zai]);
    // One transform per source, one view model for the screen: everything below
    // renders from these, never from a provider payload.
    const claudeVMs = windowsOf('claude', claudeRaw);
    const zaiVMs = windowsOf('zai', zaiPlan.raw);
    const goVMs = windowsOf('opencode', go.raw);
    const updates: PlanReadings = {};
    for (const id of PLAN_IDS) {
        const reading = readings[id];
        if (reading !== undefined && reading !== stored[id]) updates[id] = reading;
    }
    if (Object.keys(updates).length > 0) savePlans(env, updates, accounts);
    // Every plan collector's real windows, most urgent first: the borrow rule
    // and the Home card's connected strip read the same list, so a machine-level
    // view and a per-tab view can never disagree about which plan is tightest.
    const { planShapes, connected } = planStrip({ claude: claudeVMs, codex, opencode: goVMs, zai: zaiVMs });
    return {
        at: NOW.getTime(),
        capturedAt: NOW.toISOString(),
        readingsFrom,
        periods: PERIODS,
        plans: { claude: claudeVMs, codex, opencode: goVMs, zai: zaiVMs },
        shapes: planShapes,
        connected,
        providerIds,
        agents: Object.fromEntries(agents),
        reports,
        ...(ccusageFailure === undefined ? {} : { ccusageFailure }),
        zaiConnected,
        zaiModelCount: zaiModelIds.size,
        goLabel: go.label,
        zaiLabel: zaiPlan.label,
        storedFresh: Object.keys(updates).length > 0 || range !== undefined || Object.values(local).some((report) => Array.isArray(report.rows)),
    };
}

/** One tab's report, projected from the shared collection: which provider this
 *  tab answers for, its measured activity, and the limits it speaks. A
 *  projection only reshapes what the collection measured; it measures nothing
 *  of its own, so the card's compact figures and every tab's detailed ones are
 *  the same figures by construction. */
function project(raw: RawCollection, selected: string, nowMs: number, stale = false): UsageReport {
    const { plans, providerIds, reports } = raw;
    const claudeVMs = plans.claude ?? [];
    const codex = plans.codex ?? [];
    const zaiVMs = plans.zai ?? [];
    const goVMs = plans.opencode ?? [];
    const provider = selected !== '' && (providerIds.includes(selected) || reports[selected] !== undefined)
        ? selected
        : providerIds[0] ?? '';
    const activitySupported = CCUSAGE_AGENTS.has(provider) || provider === 'omp' || provider === 'zai';
    const localReport = reports[provider];
    let activityFailure = raw.ccusageFailure;
    if (localReport?.rows) activityFailure = undefined;
    // A local report gates only the activity it is itself the source of: omp
    // and pi are measured from their own transcripts, so an unavailable scan
    // really means no rows. opencode's own database is only probed for recency
    // -- its tab's activity is ccusage's, and a missing database must not
    // blank activity ccusage measured.
    if (localReport?.unavailable && (provider === 'omp' || provider === 'pi')) activityFailure = localReport.reason ?? 'Local activity unavailable';
    // Z.ai is measured from Pi's records, so ccusage's health says nothing about
    // this tab; only whether its models could be attributed does.
    if (provider === 'zai' && raw.zaiConnected && raw.zaiModelCount === 0) activityFailure = 'Local activity unavailable for this provider';
    else if (provider === 'zai' && raw.zaiConnected && reports.pi?.unavailable) activityFailure = reports.pi.reason ?? 'Local activity unavailable';
    else if (provider === 'zai' && raw.zaiConnected) activityFailure = undefined;
    const activityAvailable = activitySupported && activityFailure === undefined;
    // Only failures speak on the screen now (a notice inside the Today card).
    const days = raw.agents[provider] ?? raw.periods.map((period) => ({ period, row: undefined }));
    const totals = activityTotals(days);
    const { today, tokensToday, tokensWeek, costToday, costWeek } = totals;
    const selectedVMs = selectedWindows(provider, claudeVMs, codex, zaiVMs, goVMs);
    // A selection without its own plan collector (pi, omp, gemini, ...) borrows
    // the tightest connected plan, so the default view answers with a real
    // window instead of a machine-level "not connected" that is false whenever
    // any plan is connected. A plan tab keeps speaking for itself: its own
    // unavailable message beats another plan's numbers.
    const borrowed = (PLAN_PROVIDERS[provider] === undefined && selectedVMs.length === 0) ? raw.shapes[0] : undefined;
    const limitsVMs = borrowed !== undefined ? borrowed.vms : selectedVMs;
    const limitsPlan = borrowed !== undefined ? borrowed.plan : PLAN_PROVIDERS[provider];
    const limitsMessage = (providerIds.length > 0 && limitsVMs.length === 0)
        ? selectedLimitsMessage(provider, claudeVMs, goVMs, raw.goLabel, zaiVMs, raw.zaiLabel, codex)
        : undefined;
    const output: UsageReport = {
        providers: providerIds.map((agent) => ({ id: agent, label: TAB_LABELS[agent] ?? AGENTS[agent] ?? agent, glyph: agent })),
        provider,
        providerName: AGENTS[provider] ?? 'Usage',
        ...(providerIds.length === 0
            ? { noProviders: 'Run a coding agent on this computer or connect a plan.', noProvidersTitle: 'No supported providers detected' }
            : {}),
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
        capturedAt: raw.capturedAt,
        ...(raw.readingsFrom < raw.at ? { readingsFrom: new Date(raw.readingsFrom).toISOString() } : {}),
        windowPeriods: raw.periods,
        // The normalized view model behind every rendered rate-limit shape.
        windows: limitsVMs,
        limits: limitsPayload(limitsVMs, {
            ...(limitsPlan === undefined ? {} : { plan: limitsPlan }),
            ...(limitsMessage === undefined ? {} : { message: limitsMessage }),
        }),
        // One compact entry per provider with real quota windows, most urgent
        // first: the Home card's strip reads this instead of re-deriving every
        // tab's state from a payload that answers for one tab.
        ...(raw.connected.length === 0 ? {} : { connected: raw.connected }),
        ...(stale ? { stale: true as const } : {}),
    };
    return withAge(output, nowMs);
}

/** The age of the reading, by the host's clock, so every reader can apply its
 *  own freshness window to one number rather than the coarser cache flag. */
function withAge(output: UsageReport, nowMs: number): UsageReport {
    const capturedAt = Date.parse(output.readingsFrom ?? output.capturedAt ?? '');
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


