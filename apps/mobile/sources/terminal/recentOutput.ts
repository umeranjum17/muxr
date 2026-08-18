import { decodeBase64 } from '@/encryption/base64';

/** Rolling plain-text tail of each attached terminal, for link extraction.
 *  Bounded: the point is "the URL that just scrolled by", not a transcript. */
const MAX_CHARS = 24 * 1024;
const MAX_LINKS = 8;
const tails = new Map<string, string>();
const TEXT_DECODER = new TextDecoder();

const ANSI = /(?:\[[0-9;?]*[ -/]*[@-~]|\][^\]*(?:|\\\)|[()][0-2]|[#>=()])/g;
const URL_PATTERN = /https?:\/\/[^\s"'`<>[\]{}()\\^|]+/g;
const TRAILING = /[.,;:!?)\]]+$/;

export function recordTerminalOutput(sessionId: string, base64: string): void {
    let bytes: Uint8Array;
    try { bytes = decodeBase64(base64); } catch { return; }
    const text = TEXT_DECODER.decode(bytes).replace(ANSI, '').replace(/\r/g, '');
    const next = (tails.get(sessionId) ?? '') + text;
    tails.set(sessionId, next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next);
}

export function clearTerminalOutput(sessionId: string): void {
    tails.delete(sessionId);
}

/** Latest-first, deduped URLs from the visible-ish terminal tail. */
export function recentTerminalLinks(sessionId: string): string[] {
    const tail = tails.get(sessionId);
    if (tail === undefined || !tail.includes('http')) return [];
    const found: string[] = [];
    const seen = new Set<string>();
    const matches = tail.matchAll(URL_PATTERN);
    for (const match of matches) {
        const url = match[0].replace(TRAILING, '');
        if (url.length <= 12 || seen.has(url)) continue;
        seen.add(url);
        found.push(url);
        if (found.length >= MAX_LINKS) break;
    }
    return found.reverse();
}
