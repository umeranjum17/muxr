/**
 * Usage and machine health are product surfaces served by typed host methods.
 * The host collects, normalizes and bounds every figure; the phone owns all
 * wording, units and tone. One view-model vocabulary for every provider, so no
 * surface ever sees a provider's raw payload.
 */

/** What the host says about a plan right now; the app owns wording and tone. */
export type UsageLimitsVerdict = 'go' | 'ahead' | 'watch' | 'low' | 'limited' | 'unknown';

export interface UsageLimitsWindow {
    label: string;
    /** Published window length after the label ("5h", "7d"); omitted when the host does not know one. */
    window?: string;
    /** Percent of the window used, 0..100. */
    used: number;
    /** Duration until reset ("4h 11m"); omitted when the host has no reset time. */
    resetsIn?: string;
    /** Elapsed share, 0..1, when the length and reset are usable and some usage exists. */
    elapsed?: number;
    /** Null when the host cannot calculate pace; the phone omits its verdict and tone. */
    pace?: 'limited' | 'low' | 'watch' | 'ahead' | 'on pace' | null;
}

export interface UsageLimitsPayload {
    /** Plan name rendered beside the section label ("OpenCode Go"). */
    plan?: string;
    verdict: UsageLimitsVerdict;
    /** Host message shown as one quiet line when there is nothing to card. */
    message?: string;
    windows: UsageLimitsWindow[];
}

/** One provider pill in the Usage screen's tab strip. `glyph` is the agent
 *  mark id; unknown marks fall back to the app's own monogram. */
export interface UsageProviderTab {
    id: string;
    label: string;
    glyph: string;
}

/** One measured or modeled series point for the charts. */
export interface UsageSeriesPoint {
    label: string;
    value: number;
    valueLabel: string;
    /** Day-series carry their ISO date so a label never shifts a day. */
    detail?: string;
}

/** The normalized window behind every rendered rate-limit shape. Derived
 *  figures travel with their inputs so a render can never disagree. */
export interface UsageWindowViewModel {
    provider: string;
    windowKind: string;
    label: string;
    percentUsed: number;
    percentRemaining: number;
    windowMinutes?: number;
    resetEpochSec?: number;
    resetClock: string;
    pace: { verdict: string | null; tone: string };
}

/** One connected plan: identity plus its real quota windows, most urgent
 *  provider first as the host published them. */
export interface UsageConnectedProvider {
    id: string;
    label: string;
    glyph?: string;
    plan?: string;
    windows: UsageLimitsWindow[];
}

/** Tokens by kind. `input` is fresh input: cache reads and writes are their
 *  own figures, never folded into it. */
export interface UsageTokenCounts {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Tokens the source counted but did not itemize by kind: the rest, never a guessed kind. */
    other: number;
}

/** One local day of measured activity. */
export interface UsageActivityDay extends UsageTokenCounts {
    /** Local ISO date (YYYY-MM-DD). */
    date: string;
    /** USD, recorded by the harness or estimated at list prices; absent when
     *  nothing on the day could be priced. */
    cost?: number;
    /** Some of the day's tokens could not be priced: `cost` is a floor. */
    unpriced?: true;
}

/** One model's measured tokens, totals over today, 7 and 30 days. */
export interface UsageActivityModel {
    model: string;
    /** The provider the harness routed the model through, when it names one. */
    route?: string;
    today: number;
    week: number;
    month: number;
}

/** One provider an aggregator routed to, with that provider's own plan
 *  limits when this machine has them connected. */
export interface UsageActivityRoute {
    id: string;
    label: string;
    glyph?: string;
    today: number;
    week: number;
    month: number;
    weekCost?: number;
    monthCost?: number;
    /** Some of that span's tokens could not be priced: that span's cost is a floor. */
    weekUnpriced?: true;
    monthUnpriced?: true;
    /** The provider's own plan, never the harness's: an aggregator has none. */
    plan?: string;
    windows?: UsageLimitsWindow[];
}

/** One harness whose traffic landed on the selected plan, over 7 days. */
export interface UsageActivitySource {
    id: string;
    label: string;
    glyph: string;
    week: number;
}

/** Measured local activity for one tab: figures only, the phone owns words.
 *  `counting` is a first count still reading the session stores. */
export interface UsageActivity {
    state: 'measured' | 'counting' | 'unavailable';
    /** Why the figures are missing, and how to fix it, when they are. */
    reason?: string;
    /** Today's tokens per local hour, index 0 = midnight, up to the current hour. */
    hourly: number[];
    /** Thirty local days, oldest first, ending today. */
    days: UsageActivityDay[];
    /** Most-used models over 30 days, at most eight. */
    models: UsageActivityModel[];
    /** Aggregators: the providers the traffic went to, most used first. */
    routes?: UsageActivityRoute[];
    /** Plan tabs: which harnesses sent this plan's traffic. */
    sources?: UsageActivitySource[];
    /** Whether cost figures were recorded by the harness, estimated at list
     *  prices, or both. */
    costBasis?: 'recorded' | 'estimated' | 'mixed';
    /** The last measured record, when there is one. */
    lastActiveAt?: string;
}

/** The Usage screen payload for one selected provider tab (or the machine's
 *  default when `provider` is empty). */
export interface UsageReport {
    providers: UsageProviderTab[];
    /** The tab the payload answers for; '' when no provider was detected. */
    provider: string;
    providerName: string;
    noProvidersTitle?: string;
    noProviders?: string;
    /** Why the selected tab's local activity is a dash; silence means measured. */
    activityNotice?: string;
    /** Tokens, trends, models and routes; absent from hosts that predate it. */
    activity?: UsageActivity;
    todayTokens: string;
    todayCost: string;
    modelSeries: UsageSeriesPoint[];
    weekTokens: string;
    weekCost: string;
    weekSeries: UsageSeriesPoint[];
    capturedAt: string;
    /** The oldest plan reading shown, when a provider's last good reading
     *  stood in for a read that failed; `ageSeconds` counts from it. */
    readingsFrom?: string;
    /** How old that capture is, by the host's clock: what the screen says about
     *  the figures it is showing. Whether they are worth collecting again is a
     *  separate question the phone answers from its own record of asking. */
    ageSeconds?: number;
    /** The reported window, oldest first, always ending on today. */
    windowPeriods: string[];
    /** The selected tab's windows as plain view models, parallel to `limits`. */
    windows: UsageWindowViewModel[];
    /** The selected tab's own plan limits. A harness with no plan of its own
     *  (Pi, OMP, OpenCode) has none here: its routes carry each provider's. */
    limits: UsageLimitsPayload;
    /** Every provider with real quota windows; absent when none are connected. */
    connected?: UsageConnectedProvider[];
    /** Last-known payload replayed past the host's own fresh window. A display
     *  word about ageing figures; the phone decides whether they are worth a
     *  collection from its own window, not from this flag. */
    stale?: true;
}

/** Machine vitals as figures, not prose: the phone owns units. A filesystem
 *  the host cannot stat omits the disk pair, so the phone drops that one
 *  figure and still shows memory, load and uptime. */
export interface UsageVitals {
    memoryUsed: number;
    memoryTotal: number;
    /** `diskTotal` is used + available, which is what df divides by for Use%,
     *  not the filesystem's raw capacity. Read the pair as a share. */
    diskUsed?: number;
    diskTotal?: number;
    load1: number;
    uptimeSeconds: number;
}

/** The Home "Right now" card payload: the limits vocabulary narrowed to the
 *  one window its verdict describes, plus machine vitals. */
export interface UsageNow {
    limits: UsageLimitsPayload;
    connected?: UsageConnectedProvider[];
    /** Collection still running; the host fell back so vitals could answer. */
    collecting?: true;
    /** These are the last known figures and a collection is still running
     *  behind them: ask again shortly for the one that lands. */
    refreshing?: true;
    /** How old the limit figures are, by the host's clock. */
    ageSeconds?: number;
    /** The instant this reading was captured, by the host's clock: the host
     *  names the reading so a reader can tell a reused collection from a
     *  new one instead of inferring it from the age. */
    capturedAt?: string;
    vitals?: UsageVitals;
}
