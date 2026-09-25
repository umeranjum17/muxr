import type { UsageConnectedProvider, UsageLimitsPayload, UsageNow, UsageReport, UsageSeriesPoint, UsageVitals } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';

/** How long a collected reading stays good enough to show as it is, on both
 *  the Home card and the Usage screen: quota windows move over hours, so
 *  within this the figures are the answer and asking again costs a full
 *  collection for nothing. Doubles as the refresh cadence on
 *  both surfaces. */
export const FRESH_MS = 15 * 60_000;

/** The slack the window comparison below carries. A cadence arms its timer
 *  before its own ask is recorded, and a timer fires a hair after the instant
 *  it was scheduled for, so a cycle measuring a whole window from the last ask
 *  misses it by microseconds and then waits out a second whole window. Under a
 *  second, this can never fit two collections into one window. */
const WINDOW_SLACK_MS = 1_000;

/** A key for anything the phone remembers about a tab. What one machine reports
 *  is not evidence about another, so the record and the display below are kept
 *  per machine as well as per tab: switching machines must not let one
 *  machine's window hold back the other's first ask, nor paint its figures. */
export function machineKey(provider: string): string {
    return `${getCachedConnectionSettings().machineId}\u0000${provider}`;
}

/** When we last asked the host for a whole collection, per machine and tab: our
 *  own record of our own act of asking, on our own clock. The age of the
 *  reading that came back cannot stand in for this -- a host that cannot
 *  persist a reading (its limits or local activity unavailable) keeps serving
 *  the same old one, so its age never advances and the window would never
 *  close, and a host that reports no age at all would never open it. Module
 *  level, so a remount and a return from the foreground do not forget it. */
const askedAt = new Map<string, number>();

/** When we last asked the host to collect past its cache, per machine and tab:
 *  the floor under every forced read, kept here rather than in a mounted hook
 *  so a remount or a surface switch cannot walk around it. */
const lastForcedAt = new Map<string, number>();
const reportFailures = new Map<string, { at: number; reason: string }>();

export function reportFailure(provider: string): { at: number; reason: string } | undefined {
    return reportFailures.get(machineKey(provider));
}

export function noteReportFailure(provider: string, at: number, reason: string): void {
    reportFailures.set(machineKey(provider), { at, reason });
    writes += 1;
    for (const listener of [...listeners]) listener();
}

export function clearReportFailure(provider: string): void {
    if (!reportFailures.delete(machineKey(provider))) return;
    writes += 1;
    for (const listener of [...listeners]) listener();
}

/** The measured local activity a usage.report read carries, and the host's own
 *  words for having none. */
export interface UsageActivity {
    /** The tab the host answered for: the default view resolves to a real
     *  provider, and that is the pill the screen marks as selected. */
    provider?: string;
    todayTokens: string;
    todayCost: string;
    modelSeries: UsageSeriesPoint[];
    weekTokens: string;
    weekCost: string;
    weekSeries: UsageSeriesPoint[];
    capturedAt?: string;
    ageSeconds?: number;
    ageAt?: number;
    activityNotice?: string;
    noProvidersTitle?: string;
    noProviders?: string;
}

/** One machine's tab, as figures: the limits and plans both surfaces show, the
 *  machine facts the card measures, and the local activity the screen shows.
 *  ONE projection rather than a payload per surface: a read fills in the part
 *  it knows and leaves the rest standing unless its answer rules it out. */
export interface UsageFigures {
    limits: UsageLimitsPayload;
    /** The host's whole window list, once a report has named it: a usage.now
     *  read naming one window keeps the list; one naming none clears it. */
    windows?: UsageLimitsPayload['windows'];
    /** The one window usage.now names for the card's verdict line. A report
     *  cannot name it, so a report read keeps it. */
    cardWindow?: UsageLimitsPayload['windows'][number];
    /** Every provider with a real integration, which is the host's own tab list
     *  -- a plan with no quota windows is still a tab. */
    providers?: UsageReport['providers'];
    connected?: UsageConnectedProvider[];
    vitals?: UsageVitals;
    activity?: UsageActivity;
    ageSeconds?: number;
    ageAt?: number;
    capturedAt?: string;
}

/** What the phone can show for a machine and tab, and all it can show: figures
 *  it holds, a read it has asked for and is waiting on, or a failure with an
 *  honest reason. Three states and no fourth, so neither surface is ever left
 *  with an absence to interpret -- a blank card is the complaint this exists to
 *  answer, and each of the routes that produced one did it by treating an absent
 *  payload as nothing to render. */
export type UsageDisplay =
    | { status: 'figures'; at: number; figures: UsageFigures }
    | { status: 'waiting'; askedAt: number; vitals?: UsageVitals }
    | { status: 'unavailable'; reason: string; vitals?: UsageVitals };

/** Whether capture `a` was taken before capture `b`, both named on the host's
 *  clock. An unreadable name orders nothing, so it is never "before". */
export function capturedBefore(a: string | undefined, b: string | undefined): boolean {
    return Date.parse(a ?? '') < Date.parse(b ?? '');
}

/** A projection may only write what it can answer for. The merge keeps, from
 *  the record already held, every field the writer did not speak for; a fresh
 *  answer naming no window or connected plan clears the fields it contradicts.
 *  An answer captured before the held figures -- a cache replay reaching one
 *  surface after the other landed a collection -- never takes the limits back
 *  to it: only what it alone speaks for (activity, tabs, vitals) lands. */
function mergeFigures(held: UsageFigures | undefined, spoken: Pick<UsageFigures, 'limits'> & Partial<UsageFigures>): UsageFigures {
    if (held === undefined || !capturedBefore(spoken.capturedAt, held.capturedAt)) return { ...held, ...spoken };
    const { limits: _limits, windows: _windows, cardWindow: _cardWindow, connected: _connected, ageSeconds: _age, ageAt: _ageAt, capturedAt: _at, ...rest } = spoken;
    return { ...held, ...rest };
}

/** The figures a settled usage.now read answers for: machine facts, connected
 *  plans, and the window its verdict describes. A windowless answer clears the
 *  held full-window list; otherwise it leaves that list, the tab list, and
 *  measured activity alone. Collecting answers never reach this merge. */
export function withNow(previous: UsageFigures | undefined, value: UsageNow): UsageFigures {
    return mergeFigures(previous, {
        limits: value.limits,
        cardWindow: value.limits.windows[0],
        ...(value.limits.windows.length === 0 ? { windows: [] } : {}),
        connected: value.connected,
        ...(value.vitals === undefined ? {} : { vitals: value.vitals }),
        ...(value.ageSeconds === undefined ? {} : { ageSeconds: value.ageSeconds, ageAt: Date.now() }),
        ...(value.capturedAt === undefined ? {} : { capturedAt: value.capturedAt }),
    });
}

/** The figures a usage.report read answers for: the whole window list, the tab
 *  list and the activity. It cannot speak for the machine facts. */
export function withReport(previous: UsageFigures | undefined, value: UsageReport): UsageFigures {
    const now = Date.now();
    const activityCapturedAt = Date.parse(value.capturedAt);
    return mergeFigures(previous, {
        limits: value.limits,
        windows: value.limits.windows,
        // A report naming no window has answered for the card's one window: an
        // older value of it must not outlive the answer that contradicts it.
        ...(value.limits.windows.length === 0 ? { cardWindow: undefined } : {}),
        providers: value.providers,
        activity: {
            ...(value.provider === '' ? {} : { provider: value.provider }),
            todayTokens: value.todayTokens,
            todayCost: value.todayCost,
            modelSeries: value.modelSeries,
            weekTokens: value.weekTokens,
            weekCost: value.weekCost,
            weekSeries: value.weekSeries,
            capturedAt: value.capturedAt,
            ...(Number.isFinite(activityCapturedAt) ? { ageSeconds: Math.max(0, (now - activityCapturedAt) / 1_000), ageAt: now } : {}),
            ...(value.activityNotice === undefined ? {} : { activityNotice: value.activityNotice }),
            ...(value.noProvidersTitle === undefined ? {} : { noProvidersTitle: value.noProvidersTitle }),
            ...(value.noProviders === undefined ? {} : { noProviders: value.noProviders }),
        },
        connected: value.connected,
        ...(value.ageSeconds === undefined ? {} : { ageSeconds: value.ageSeconds, ageAt: now }),
        ...(value.capturedAt === undefined ? {} : { capturedAt: value.capturedAt }),
    });
}

const displays = new Map<string, UsageDisplay>();
const listeners = new Set<() => void>();
let writes = 0;

/** Whether this machine's tab may be asked for a collection at `nowMs`: our own
 *  window has passed since we last asked, or we have never asked. Decided from
 *  when we asked, never from what the host answered -- and recorded against the
 *  same instant by `noteAsked`, so a cadence measures a whole window from where
 *  it decided rather than from a round trip. */
export function collectionDue(provider: string, nowMs: number): boolean {
    const last = askedAt.get(machineKey(provider));
    return last === undefined || nowMs - last >= FRESH_MS - WINDOW_SLACK_MS;
}

/** Note that we asked for this machine's tab at `nowMs`, opening a new window. */
export function noteAsked(provider: string, nowMs: number): void {
    askedAt.set(machineKey(provider), nowMs);
}

/** Let go of a claim this read made, if it is still the one standing. A read
 *  that was abandoned or superseded has no answer coming, so holding its claim
 *  would lock the tab out for the rest of the window with nothing on the way;
 *  this only restores eligibility, and never asks anything itself. A read the
 *  host answered -- including one it answered with a failure -- keeps its
 *  claim, and a newer ask's claim is left alone. */
export function releaseAsked(provider: string, nowMs: number): void {
    const key = machineKey(provider);
    if (askedAt.get(key) === nowMs) askedAt.delete(key);
}

/** Read every write: one store, and a surface paints what the other stored the
 *  moment it lands rather than what happened to be there when it mounted. */
export function subscribeUsage(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** How many writes have landed: a surface subscribes to this, so any change to
 *  any tab re-renders it, and it reads the store itself. */
export function usageWrites(): number {
    return writes;
}

/** Every tab this machine has figures for, as the host wrote them: a tab strip
 *  survives a tab that is only waiting or unavailable. */
export function knownProviders(): UsageReport['providers'] {
    const machine = getCachedConnectionSettings().machineId;
    const tabs = new Map<string, UsageReport['providers'][number]>();
    for (const [key, display] of displays) {
        if (!key.startsWith(`${machine}\u0000`) || display.status !== 'figures') continue;
        for (const tab of display.figures.providers ?? []) if (!tabs.has(tab.id)) tabs.set(tab.id, tab);
    }
    return [...tabs.values()];
}

/** Note a forced read on this machine's tab at `nowMs`. */
export function noteForcedRead(provider: string, nowMs: number): void {
    lastForcedAt.set(machineKey(provider), nowMs);
}

/** When the last forced read on this machine's tab started, if there has been
 *  one: `forcedReadWait` measures the budget from here. */
export function lastForcedRead(provider: string): number {
    return lastForcedAt.get(machineKey(provider)) ?? 0;
}

/** When the Usage screen last asked for this machine's tab list, if it has.
 *  The question is this surface's own: another surface's ask answers nothing
 *  about it, so it is recorded here rather than read off the shared ask time. */
const tabListAskedAt = new Map<string, number>();

/** Note that the screen asked for this machine's tab list at `nowMs`. */
export function noteTabListAsked(provider: string, nowMs: number): void {
    tabListAskedAt.set(machineKey(provider), nowMs);
}

/** Whether the tab-list question is still owed for a record written at
 *  `recordAt`: no ask has answered it since that record landed. */
export function tabListAskOwed(provider: string, recordAt: number): boolean {
    const asked = tabListAskedAt.get(machineKey(provider));
    return asked === undefined || asked < recordAt;
}

/** The last limits this machine holds for one provider, from the connected
 *  strip of any record that carries it: what a tab whose own read has never
 *  answered can still show instead of a blank. Another provider's refused
 *  read must not take a figure the reader already saw away. */
export function lastKnownPlan(provider: string): { plan: string; windows: UsageLimitsPayload['windows']; ageSeconds?: number; capturedAt?: string; shownAt: number } | undefined {
    const machine = getCachedConnectionSettings().machineId;
    let newest: { at: number; plan: string; windows: UsageLimitsPayload['windows']; ageSeconds?: number; capturedAt?: string; shownAt: number } | undefined;
    for (const [key, display] of displays) {
        if (!key.startsWith(`${machine}\u0000`) || display.status !== 'figures') continue;
        const plan = (display.figures.connected ?? []).find((candidate) => candidate.id === provider);
        if (plan === undefined || plan.windows.length === 0) continue;
        const at = Date.parse(display.figures.capturedAt ?? '');
        if (newest !== undefined && !(at > newest.at)) continue;
        newest = {
            at: Number.isFinite(at) ? at : -Infinity,
            plan: plan.plan ?? plan.label,
            windows: plan.windows,
            shownAt: display.figures.ageAt ?? display.at,
            ...(display.figures.ageSeconds === undefined ? {} : { ageSeconds: display.figures.ageSeconds }),
            ...(Number.isFinite(at) ? { capturedAt: display.figures.capturedAt } : {}),
        };
    }
    if (newest === undefined) return undefined;
    const { at: _at, ...reading } = newest;
    return reading;
}

/** What this machine's tab shows, if anything has been asked for it yet. */
export function shownUsage(provider: string): UsageDisplay | undefined {
    return displays.get(machineKey(provider));
}

/** Remember what this machine's tab shows: the figures a read painted, the wait
 *  an ask left behind, or the failure one ended in. In memory only, with the
 *  ask record's lifetime, and the one thing both surfaces paint. */
export function rememberShown(provider: string, display: UsageDisplay): void {
    displays.set(machineKey(provider), display);
    writes += 1;
    for (const listener of [...listeners]) listener();
}
