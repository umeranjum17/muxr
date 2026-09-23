import type { UsageConnectedProvider, UsageLimitsPayload, UsageNow, UsageReport, UsageSeriesPoint, UsageVitals } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';

/** How long a collected reading stays good enough to show as it is, on both
 *  the Home card and the Usage screen: quota windows move over hours, so
 *  within this the figures are the answer and asking again costs a full
 *  collection for nothing. Past it a read asks the host to collect again
 *  rather than be served the same payload -- the usage cache answers with any
 *  same-day payload, so nothing else makes figures a reader can see are old
 *  become current. Doubles as the refresh cadence on both surfaces. */
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
    activityNotice?: string;
    noProvidersTitle?: string;
    noProviders?: string;
}

/** One machine's tab, as figures: the limits and plans both surfaces show, the
 *  machine facts the card measures, and the local activity the screen shows.
 *  ONE projection rather than a payload per surface, so the last writer cannot
 *  narrow what the other had: a read fills in the part it knows and leaves the
 *  rest of what is held standing. */
export interface UsageFigures {
    limits: UsageLimitsPayload;
    /** The host's whole window list, once a report has named it: usage.now
     *  names one window, so a card read keeps this rather than narrowing it. */
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

/** A projection may only write what it can answer for. The merge keeps, from
 *  the record already held, every field the writer did not speak for -- so a
 *  narrower read can never narrow a wider one, and a field added later never
 *  has to rediscover this. */
function mergeFigures(held: UsageFigures | undefined, spoken: Pick<UsageFigures, 'limits'> & Partial<UsageFigures>): UsageFigures {
    return { ...held, ...spoken };
}

/** The figures a usage.now read answers for: the machine facts it measured, and
 *  the one window its verdict describes. It cannot speak for the host's whole
 *  window list, the tab list, or the measured activity. */
export function withNow(previous: UsageFigures | undefined, value: UsageNow): UsageFigures {
    return mergeFigures(previous, {
        limits: value.limits,
        cardWindow: value.limits.windows[0],
        ...(value.connected === undefined ? {} : { connected: value.connected }),
        ...(value.vitals === undefined ? {} : { vitals: value.vitals }),
        ...(value.ageSeconds === undefined ? {} : { ageSeconds: value.ageSeconds }),
        ...(value.capturedAt === undefined ? {} : { capturedAt: value.capturedAt }),
    });
}

/** The figures a usage.report read answers for: the whole window list, the tab
 *  list and the activity. It cannot speak for the machine facts. */
export function withReport(previous: UsageFigures | undefined, value: UsageReport): UsageFigures {
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
            ...(value.activityNotice === undefined ? {} : { activityNotice: value.activityNotice }),
            ...(value.noProvidersTitle === undefined ? {} : { noProvidersTitle: value.noProvidersTitle }),
            ...(value.noProviders === undefined ? {} : { noProviders: value.noProviders }),
        },
        connected: value.connected,
        ...(value.ageSeconds === undefined ? {} : { ageSeconds: value.ageSeconds }),
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
