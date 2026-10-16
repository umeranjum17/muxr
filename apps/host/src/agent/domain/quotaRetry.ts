const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/**
 * What Home says while an agent's plan or quota keeps it retrying. Plain
 * words only: no ids, no paths, no error codes.
 */
export const QUOTA_RETRY_REASON = 'Plan or quota ran out. Waiting to retry.';

/** Either side alone is chat; together on one screen they are a retry loop. */
const QUOTA_SIDE =
    /\bquota\b|\brate[\s_-]*limits?\b|\bplan\b.{0,40}\blimit\b|\blimit\b.{0,40}\bplan\b|\busage\b.{0,40}\blimit\b|\blimit\b.{0,20}\b(exceed|exhaust|reach)/i;
const RETRY_SIDE =
    /\bretr\w+\b|\bwaiting\b|\bbackoff\b|\btry again\b|\bresets?\s+(in|at)\b|\bpaus(e|ed|ing)\b/i;

/**
 * The quota-retry reason when a pane's recent output shows a plan/quota
 * retry loop, else undefined. Returns only the shared constant, never pane
 * text, so terminal output cannot leak into notices.
 */
export function quotaRetryDetail(text: string | null | undefined): string | undefined {
    if (text === null || text === undefined || text.trim() === '') return undefined;
    const clean = text.replace(ANSI, '');
    if (!QUOTA_SIDE.test(clean) || !RETRY_SIDE.test(clean)) return undefined;
    return QUOTA_RETRY_REASON;
}

/** The last `count` lines of a pane read, where a retry loop would print. */
export function tailLines(text: string, count: number): string {
    if (count <= 0) return '';
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - count)).join('\n');
}
