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
    /** How much of the window has elapsed, 0..1, when the length is known. */
    elapsed?: number;
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
    pace: { verdict: string; tone: string };
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
    todayTokens: string;
    todayCost: string;
    modelSeries: UsageSeriesPoint[];
    weekTokens: string;
    weekCost: string;
    weekSeries: UsageSeriesPoint[];
    capturedAt: string;
    /** How old that capture is, by the host's clock: the reading's age, on the
     *  one clock the phone can threshold without asking the host whether the
     *  figures are old enough to be worth collecting again. */
    ageSeconds?: number;
    /** The reported window, oldest first, always ending on today. */
    windowPeriods: string[];
    /** The selected tab's windows as plain view models, parallel to `limits`. */
    windows: UsageWindowViewModel[];
    /** The rendered limits payload; a planless selection borrows the tightest
     *  connected plan so the default view never lies about being disconnected. */
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
    /** Cold usage cache; the host fell back so the vitals could answer. */
    collecting?: true;
    /** How old the limit figures are, by the host's clock. */
    ageSeconds?: number;
    /** The instant this reading was captured, by the host's clock: the host
     *  names the reading so a reader can tell a replayed cache entry from a
     *  new collection instead of inferring it from the age. */
    capturedAt?: string;
    vitals?: UsageVitals;
}
