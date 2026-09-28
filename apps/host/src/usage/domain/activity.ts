/**
 * One tab's measured activity, from the ledger's hourly rows: daily and hourly
 * trends, top models, and -- for a harness that routes to several providers --
 * the split by provider with each provider's own plan limits. Pure: figures
 * in, figures out; the phone owns every word.
 */
import type {
    UsageActivity, UsageActivityDay, UsageActivityModel, UsageActivityRoute, UsageActivitySource, UsageLimitsWindow,
} from '@muxr/contract';

export type Harness = 'pi' | 'omp' | 'claude' | 'codex' | 'opencode';

/** One hour of one model through one route in one harness. */
export interface LedgerRow {
    /** A ledger harness, or an agent measured by the pinned daily backend. */
    harness: string;
    route: string;
    model: string;
    /** Local hour, `YYYY-MM-DDTHH`. */
    hour: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** USD over the records that could be priced. */
    cost: number;
    /** Some record in the bucket could not be priced. */
    unpriced: boolean;
    /** The cost is a list-price estimate, not the harness's own record. */
    estimated: boolean;
    /** The newest record, epoch ms. */
    latest: number;
}

export type PlanId = 'claude' | 'codex' | 'opencode' | 'zai';

export interface PlanLimits {
    plan: string;
    windows: UsageLimitsWindow[];
}

/** Harnesses that route to many providers and hold no plan of their own. */
export const AGGREGATORS = new Set(['pi', 'omp', 'opencode']);

/** How each harness names a provider route, as the Usage screen names it. */
const ROUTES: Record<string, { label: string; glyph?: string }> = {
    'openai-codex': { label: 'OpenAI Codex', glyph: 'codex' },
    openai: { label: 'OpenAI', glyph: 'codex' },
    'azure-openai-responses': { label: 'Azure OpenAI', glyph: 'codex' },
    anthropic: { label: 'Anthropic', glyph: 'claude' },
    'claude-bridge': { label: 'Claude', glyph: 'claude' },
    zai: { label: 'Z.ai', glyph: 'zai' },
    'zai-coding-plan': { label: 'Z.ai', glyph: 'zai' },
    'opencode-go': { label: 'OpenCode Go', glyph: 'opencode' },
    opencode: { label: 'OpenCode Zen', glyph: 'opencode' },
    'kimi-coding': { label: 'Kimi', glyph: 'kimi' },
    moonshotai: { label: 'Kimi', glyph: 'kimi' },
    google: { label: 'Google', glyph: 'gemini' },
    'google-gemini-cli': { label: 'Gemini', glyph: 'gemini' },
    xai: { label: 'xAI', glyph: 'grok' },
    cursor: { label: 'Cursor', glyph: 'cursor' },
    'github-copilot': { label: 'Copilot', glyph: 'copilot' },
    deepseek: { label: 'DeepSeek' },
    openrouter: { label: 'OpenRouter' },
    groq: { label: 'Groq' },
    mistral: { label: 'Mistral' },
};

export function routeIdentity(route: string): { label: string; glyph?: string } {
    const known = ROUTES[route.toLowerCase()];
    if (known !== undefined) return known;
    const label = route.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 32);
    return { label: label === '' ? 'Unknown' : label };
}

/**
 * The plan a row's traffic spends, when it spends one. A harness's own
 * default route is its own plan; an aggregator's route is the provider's.
 * `anthropic` spends the Claude plan only when signed in through it, not
 * through an API key.
 */
export function rowPlan(harness: string, route: string, anthropicSubscription: boolean): PlanId | undefined {
    const id = route.toLowerCase();
    if (harness === 'claude' && id === 'anthropic') return 'claude';
    if (harness === 'codex' && id === 'openai') return 'codex';
    if (id === 'openai-codex') return 'codex';
    if (id === 'claude-bridge' || (id === 'anthropic' && anthropicSubscription && harness !== 'claude')) return 'claude';
    if (id === 'zai' || id === 'zai-coding-plan') return 'zai';
    if (id === 'opencode-go') return 'opencode';
    return undefined;
}

export const total = (row: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
    row.input + row.output + row.cacheRead + row.cacheWrite;

export interface TabActivityInput {
    /** The tab's own rows. */
    rows: LedgerRow[];
    /** Thirty local dates, oldest first, ending today. */
    dates: string[];
    /** The current local hour, `YYYY-MM-DDTHH`. */
    nowHour: string;
    /** Whether the rows carry real hours (the daily backend's do not). */
    hourly: boolean;
    /** Split by route: the tab is an aggregator. */
    routes: boolean;
    /** Connected plans, for the limits beside each route. */
    plans: Partial<Record<PlanId, PlanLimits>>;
    /** The tab's own plan: its route row does not repeat the plan card above it. */
    ownPlan?: PlanId;
    /** Plan tabs: every harness's rows that spent this plan. */
    planRows?: LedgerRow[];
    /** The tab itself: sources that are only this tab say nothing new. */
    tabId: string;
    /** Harness id -> tab label, for the plan's sources. */
    harnessLabel?: (id: string) => string;
    anthropicSubscription: boolean;
}

function basisOf(recorded: boolean, estimated: boolean): Pick<UsageActivity, 'costBasis'> {
    if (recorded && estimated) return { costBasis: 'mixed' };
    if (estimated) return { costBasis: 'estimated' };
    if (recorded) return { costBasis: 'recorded' };
    return {};
}

export function tabActivity(input: TabActivityInput): UsageActivity {
    const { rows, dates, nowHour } = input;
    const today = dates[dates.length - 1]!;
    const weekFrom = dates[Math.max(0, dates.length - 7)]!;
    const byDate = new Map(dates.map((date) => [date, { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false, unpriced: false } as Omit<UsageActivityDay, 'unpriced'> & { cost: number; priced: boolean; unpriced: boolean }]));
    const hours = Number(nowHour.slice(11, 13));
    const hourly = input.hourly ? Array.from({ length: hours + 1 }, () => 0) : [];
    const models = new Map<string, UsageActivityModel>();
    const routes = new Map<string, UsageActivityRoute>();
    let recorded = false;
    let estimated = false;
    let latest = 0;
    for (const row of rows) {
        const date = row.hour.slice(0, 10);
        const day = byDate.get(date);
        if (day === undefined) continue;
        const tokens = total(row);
        day.input += row.input; day.output += row.output; day.cacheRead += row.cacheRead; day.cacheWrite += row.cacheWrite;
        if (!row.unpriced || row.cost > 0) { day.cost += row.cost; day.priced = true; }
        if (row.unpriced) day.unpriced = true;
        if (row.estimated) estimated = true; else if (!row.unpriced) recorded = true;
        latest = Math.max(latest, row.latest);
        if (date === today && input.hourly) {
            const hour = Number(row.hour.slice(11, 13));
            if (hour >= 0 && hour < hourly.length) hourly[hour]! += tokens;
        }
        const period = { today: date === today ? tokens : 0, week: date >= weekFrom ? tokens : 0, month: tokens };
        const modelKey = `${row.route}\u0000${row.model}`;
        const model = models.get(modelKey) ?? { model: row.model, ...(input.routes ? { route: routeIdentity(row.route).label } : {}), today: 0, week: 0, month: 0 };
        model.today += period.today; model.week += period.week; model.month += period.month;
        models.set(modelKey, model);
        if (input.routes) {
            const identity = routeIdentity(row.route);
            const route = routes.get(row.route) ?? { id: row.route, label: identity.label, ...(identity.glyph === undefined ? {} : { glyph: identity.glyph }), today: 0, week: 0, month: 0 };
            route.today += period.today; route.week += period.week; route.month += period.month;
            if (!row.unpriced || row.cost > 0) {
                if (date >= weekFrom) route.weekCost = (route.weekCost ?? 0) + row.cost;
                route.monthCost = (route.monthCost ?? 0) + row.cost;
            }
            routes.set(row.route, route);
        }
    }
    const days = [...byDate.values()].map(({ priced, cost, unpriced, ...day }): UsageActivityDay => ({ ...day, ...(priced ? { cost } : {}), ...(unpriced === true ? { unpriced } : {}) }));
    const activity: UsageActivity = {
        state: 'measured',
        hourly,
        days,
        models: [...models.values()].filter((model) => model.month > 0).sort((a, b) => b.month - a.month).slice(0, 8),
        ...basisOf(recorded, estimated),
        ...(latest > 0 ? { lastActiveAt: new Date(latest).toISOString() } : {}),
    };
    if (input.routes) {
        activity.routes = [...routes.values()].sort((a, b) => b.month - a.month).slice(0, 8).map((route) => {
            const plan = rowPlan('aggregator', route.id, input.anthropicSubscription);
            const limits = plan === undefined || plan === input.ownPlan ? undefined : input.plans[plan];
            return limits === undefined || limits.windows.length === 0 ? route : { ...route, plan: limits.plan, windows: limits.windows };
        });
    }
    if (input.planRows !== undefined) {
        const sources = new Map<string, number>();
        for (const row of input.planRows) {
            if (row.hour.slice(0, 10) < weekFrom) continue;
            sources.set(row.harness, (sources.get(row.harness) ?? 0) + total(row));
        }
        const list = [...sources].filter(([, week]) => week > 0).sort((a, b) => b[1] - a[1])
            .map(([id, week]): UsageActivitySource => ({ id, label: input.harnessLabel?.(id) ?? id, glyph: id, week }));
        if (list.some((source) => source.id !== input.tabId)) activity.sources = list.slice(0, 6);
    }
    return activity;
}
