import { decodeBase64 } from '@/encryption/base64';

/** Rolling plain-text tail of recently attached terminals for link extraction. */
const MAX_CHARS = 24 * 1024;
const MAX_LINKS = 8;
const MAX_SESSIONS = 32;

type EscapeState = 'text' | 'escape' | 'escapeIntermediate' | 'csi' | 'string' | 'stringEscape';
type TailState = { text: string; escape: EscapeState; decoder: TextDecoder };
const tails = new Map<string, TailState>();

const URL_PATTERN = /https?:\/\/[^\s"'`<>[\]{}()\\^|]+/g;
const TRAILING = /[.,;:!?)\]]+$/;
const UNSAFE_URL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function touch(sessionId: string, state?: TailState): TailState {
    const current = state ?? tails.get(sessionId) ?? { text: '', escape: 'text', decoder: new TextDecoder() };
    tails.delete(sessionId);
    tails.set(sessionId, current);
    if (tails.size > MAX_SESSIONS) tails.delete(tails.keys().next().value!);
    return current;
}

/** Strip terminal control sequences across socket-message boundaries. */
function appendVisible(state: TailState, input: string): void {
    let visible = '';
    for (const char of input) {
        const code = char.charCodeAt(0);
        if (state.escape === 'text') {
            if (code === 0x1b) state.escape = 'escape';
            else if (code === 0x9b) state.escape = 'csi';
            else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) state.escape = 'string';
            else visible += char;
        } else if (state.escape === 'escape') {
            if (char === '[') state.escape = 'csi';
            else if (']PX^_'.includes(char)) state.escape = 'string';
            else if (code >= 0x20 && code <= 0x2f) state.escape = 'escapeIntermediate';
            else if (code !== 0x1b) state.escape = 'text';
        } else if (state.escape === 'escapeIntermediate') {
            if (code >= 0x30 && code <= 0x7e) state.escape = 'text';
            else if (code === 0x1b) state.escape = 'escape';
        } else if (state.escape === 'csi') {
            if (code >= 0x40 && code <= 0x7e) state.escape = 'text';
        } else if (state.escape === 'string') {
            if (code === 0x07 || code === 0x9c) state.escape = 'text';
            else if (code === 0x1b) state.escape = 'stringEscape';
        } else if (char === '\\') {
            state.escape = 'text';
        } else if (code !== 0x1b) {
            state.escape = 'string';
        }
    }
    state.text = (state.text + visible).replace(/\r/g, '').slice(-MAX_CHARS);
}

export function recordTerminalOutput(sessionId: string, base64: string): void {
    let bytes: Uint8Array;
    try { bytes = decodeBase64(base64); } catch { return; }
    const state = touch(sessionId);
    appendVisible(state, state.decoder.decode(bytes, { stream: true }));
}

export function clearTerminalOutput(sessionId: string): void {
    tails.delete(sessionId);
}

/** Latest-first, deduped and canonical URLs from the visible terminal tail. */
export function recentTerminalLinks(sessionId: string): string[] {
    const state = tails.get(sessionId);
    if (state === undefined || !state.text.includes('http')) return [];
    touch(sessionId, state);
    const found: string[] = [];
    const seen = new Set<string>();
    const matches = [...state.text.matchAll(URL_PATTERN)];
    for (let index = matches.length - 1; index >= 0 && found.length < MAX_LINKS; index--) {
        const candidate = matches[index]![0].replace(TRAILING, '');
        if (candidate.length <= 12 || candidate.length > 2048 || UNSAFE_URL_CHARS.test(candidate)) continue;
        try {
            const parsed = new URL(candidate);
            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '' || seen.has(parsed.href)) continue;
            seen.add(parsed.href);
            found.push(parsed.href);
        } catch {}
    }
    return found;
}
