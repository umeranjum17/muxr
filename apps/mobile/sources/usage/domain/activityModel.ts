import type { UsageActivity, UsageActivityDay, UsageLimitsWindow, UsageTokenCounts } from '@muxr/contract';
import { runOutMs } from '@/plugins/limits';

/** Tokens in the compact voice every usage figure speaks: 881M, 2.9B, 4.2K. */
export function compactTokens(value: number): string {
    const abs = Math.max(0, value);
    const unit = (scale: number, suffix: string) => {
        const scaled = abs / scale;
        return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    };
    if (abs >= 1e9) return unit(1e9, 'B');
    if (abs >= 1e6) return unit(1e6, 'M');
    if (abs >= 1e3) return unit(1e3, 'K');
    return String(Math.round(abs));
}

/** Dollars: cents below a hundred, whole dollars past it, thousands as "k". */
export function compactMoney(value: number): string {
    if (value >= 10_000) return `$${Number((value / 1_000).toFixed(1))}k`;
    if (value >= 100) return `$${Math.round(value).toLocaleString('en-US')}`;
    return `$${value.toFixed(2)}`;
}

export const dayTotal = (day: UsageTokenCounts): number => day.input + day.output + day.cacheRead + day.cacheWrite + day.other;

export interface RangeSummary {
    days: UsageActivityDay[];
    total: number;
    /** Undefined when nothing in the range was priced. */
    cost?: number;
    /** Some tokens in the range could not be priced: the cost is a floor. */
    partial: boolean;
    average: number;
    split: UsageTokenCounts;
}

/** The last `span` days of a tab's thirty. */
export function rangeSummary(activity: UsageActivity, span: 7 | 30): RangeSummary {
    const days = activity.days.slice(-span);
    const split = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0 };
    let cost: number | undefined;
    let partial = false;
    for (const day of days) {
        split.input += day.input; split.output += day.output; split.cacheRead += day.cacheRead; split.cacheWrite += day.cacheWrite; split.other += day.other;
        if (day.cost !== undefined) cost = (cost ?? 0) + day.cost;
        if (day.unpriced === true || (day.cost === undefined && dayTotal(day) > 0)) partial = true;
    }
    const total = dayTotal(split);
    return { days, total, ...(cost === undefined ? {} : { cost }), partial, average: days.length === 0 ? 0 : total / days.length, split };
}

/** Today against the days before it, when there is a usual to compare with. */
export function todayVersusUsual(activity: UsageActivity): number | undefined {
    const before = activity.days.slice(-8, -1).filter((day) => dayTotal(day) > 0);
    const today = activity.days[activity.days.length - 1];
    if (before.length < 3 || today === undefined) return undefined;
    const usual = before.reduce((sum, day) => sum + dayTotal(day), 0) / before.length;
    return usual > 0 ? dayTotal(today) / usual : undefined;
}

export interface Insight {
    icon: 'hourglass-outline' | 'git-branch-outline' | 'trending-up' | 'trending-down' | 'layers-outline' | 'people-outline' | 'moon-outline';
    text: string;
    tone?: 'warning' | 'danger';
}


function when(ms: number, now: Date): string {
    if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
    if (ms < 20 * 3_600_000) return `in about ${Math.round(ms / 3_600_000)}h`;
    const at = new Date(now.getTime() + ms);
    return at.toLocaleDateString('en-US', { weekday: 'long' }) === now.toLocaleDateString('en-US', { weekday: 'long' })
        ? 'later today'
        : `${at.toLocaleDateString('en-US', { weekday: 'long' })} around ${at.toLocaleTimeString('en-US', { hour: 'numeric' })}`;
}

/** Plain-language reading of one tab's figures: at most three, the most
 *  actionable first. Words are the phone's; every number is the host's. */
export function activityInsights(input: {
    activity: UsageActivity;
    tab: string;
    /** The tab's own plan limits, and every route's. */
    limits: Array<{ plan: string; windows: UsageLimitsWindow[] }>;
    now?: Date;
}): Insight[] {
    const { activity, tab } = input;
    const now = input.now ?? new Date();
    const insights: Insight[] = [];

    // 1. A limit that runs out before it resets is the one thing worth
    //    acting on; a limit already spent is next.
    let soonest: { ms: number; plan: string; window: UsageLimitsWindow } | undefined;
    let spent: { plan: string; window: UsageLimitsWindow } | undefined;
    for (const { plan, windows } of input.limits) {
        for (const window of windows) {
            if (window.used >= 100 || window.pace === 'limited') { spent ??= { plan, window }; continue; }
            const ms = runOutMs(window);
            if (ms !== undefined && (soonest === undefined || ms < soonest.ms)) soonest = { ms, plan, window };
        }
    }
    if (spent !== undefined) {
        insights.push({ icon: 'hourglass-outline', tone: 'danger', text: `${spent.plan}’s ${spent.window.label.toLowerCase()} limit is used up${spent.window.resetsIn === undefined ? '' : ` · resets in ${spent.window.resetsIn}`}` });
    } else if (soonest !== undefined) {
        insights.push({ icon: 'hourglass-outline', tone: soonest.ms < 3_600_000 ? 'danger' : 'warning', text: `At this pace ${soonest.plan}’s ${soonest.window.label.toLowerCase()} limit runs out ${when(soonest.ms, now)}${soonest.window.resetsIn === undefined ? '' : ` · it resets in ${soonest.window.resetsIn}`}` });
    }

    const week = rangeSummary(activity, 7);
    if (week.total === 0) {
        const last = activity.lastActiveAt === undefined ? undefined : new Date(activity.lastActiveAt);
        insights.push({ icon: 'moon-outline', text: last === undefined || Number.isNaN(last.getTime())
            ? `No ${tab} activity in the last 30 days`
            : `No ${tab} activity this week · last used ${last.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}` });
        return insights.slice(0, 3);
    }

    // 2. Where the traffic came from (a plan) or went (an aggregator).
    const sources = activity.sources ?? [];
    const sourcesTotal = sources.reduce((sum, source) => sum + source.week, 0);
    const lead = sources[0];
    if (lead !== undefined && sourcesTotal > 0 && lead.label !== tab) {
        const share = lead.week / sourcesTotal;
        const amount = share >= 0.995 && sources.length > 1 ? 'nearly all' : `${Math.round(share * 100)}%`;
        insights.push({ icon: 'people-outline', text: `${lead.label} sent ${amount} of this plan’s traffic this week` });
    }
    const today = activity.days[activity.days.length - 1];
    const todayTotal = today === undefined ? 0 : dayTotal(today);
    const useToday = todayTotal > 0;
    const topModel = [...activity.models].sort((a, b) => (useToday ? b.today - a.today : b.week - a.week))[0];
    const topTokens = useToday ? topModel?.today ?? 0 : topModel?.week ?? 0;
    const modelShare = topTokens / (useToday ? todayTotal : week.total);
    // One model is no finding: the models card already says so.
    const busyModels = activity.models.filter((model) => (useToday ? model.today : model.week) > 0).length;
    if (topModel !== undefined && modelShare > 0 && busyModels > 1) {
        const period = useToday ? 'today’s' : 'this week’s';
        const via = topModel.route === undefined ? '' : ` via ${topModel.route}`;
        insights.push({ icon: 'git-branch-outline', text: `${Math.round(modelShare * 100)}% of ${period} tokens went to ${topModel.model}${via}` });
    }

    // 3. Today against the usual day.
    const ratio = todayVersusUsual(activity);
    const hour = now.getHours();
    if (ratio !== undefined && ratio >= 1.25) {
        insights.push({ icon: 'trending-up', text: ratio >= 2 ? `Busy day: already ${Number(ratio.toFixed(1))}× your usual daily tokens` : `Busier than usual: ${Math.round((ratio - 1) * 100)}% above your daily average already` });
    } else if (ratio !== undefined && hour >= 14 && ratio <= 0.5) {
        insights.push({ icon: 'trending-down', text: `Quieter than usual: ${Math.round(ratio * 100)}% of an average day so far` });
    }

    // 4. Most tokens are cache reads on a long-running agent: say so, since it
    //    is why a huge number costs far less than it looks.
    const cacheShare = week.total === 0 ? 0 : week.split.cacheRead / week.total;
    if (cacheShare >= 0.8) {
        insights.push({ icon: 'layers-outline', text: `${Math.round(cacheShare * 100)}% of this week’s tokens were cache reads, billed at a fraction of fresh input` });
    }
    return insights.slice(0, 3);
}
