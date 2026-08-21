import { decodeBase64 } from '@/encryption/base64';

/** Rolling plain-text tail of recently attached terminals for link extraction. */
const MAX_CHARS = 24 * 1024;
const MAX_LINKS = 8;
const MAX_SESSIONS = 32;
/** A fast fling repaints several screens before the scroll debounce fires. */
const MAX_SCREEN_CHARS = 16 * 1024;
const SCROLL_SCAN_DEBOUNCE_MS = 120;
/** A freshly printed URL triggers at most one chip refresh per burst. */
const TAIL_NOTIFY_DEBOUNCE_MS = 300;

type EscapeState = 'text' | 'escape' | 'escapeIntermediate' | 'csi' | 'string' | 'stringEscape';
type TailState = {
    chunks: string[];
    length: number;
    escape: EscapeState;
    decoder: TextDecoder;
    capturing: boolean;
    screen: string;
    scanTimer: ReturnType<typeof setTimeout> | undefined;
    tailTimer: ReturnType<typeof setTimeout> | undefined;
    viewportLinks: string[];
    columns: number;
};
const tails = new Map<string, TailState>();

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/g;
const MAX_URL_CHARS = 8 * 1024;
const UNSAFE_URL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function trimTrailingPunctuation(value: string): string {
    let end = value.length;
    while (end > 0 && '.,;:!?'.includes(value[end - 1]!)) end--;
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
        let balance = 0;
        for (let index = 0; index < end; index++) {
            if (value[index] === open) balance++;
            else if (value[index] === close) balance--;
        }
        while (balance < 0 && value[end - 1] === close) { end--; balance++; }
    }
    return value.slice(0, end);
}

type LinksListener = (sessionId: string) => void;
const linksListeners = new Set<LinksListener>();

/** Fires when a session's viewport links or freshly printed links change. */
export function subscribeTerminalLinks(listener: LinksListener): () => void {
    linksListeners.add(listener);
    return () => { linksListeners.delete(listener); };
}

function notifyLinks(sessionId: string): void {
    for (const listener of linksListeners) listener(sessionId);
}

function newState(): TailState {
    return {
        chunks: [],
        length: 0,
        escape: 'text',
        decoder: new TextDecoder(),
        capturing: false,
        screen: '',
        scanTimer: undefined,
        tailTimer: undefined,
        viewportLinks: [],
        columns: 0,
    };
}

function drop(sessionId: string): void {
    const state = tails.get(sessionId);
    if (state === undefined) return;
    if (state.scanTimer !== undefined) clearTimeout(state.scanTimer);
    if (state.tailTimer !== undefined) clearTimeout(state.tailTimer);
    tails.delete(sessionId);
}

function touch(sessionId: string, state?: TailState): TailState {
    const current = state ?? tails.get(sessionId) ?? newState();
    tails.delete(sessionId);
    tails.set(sessionId, current);
    if (tails.size > MAX_SESSIONS) drop(tails.keys().next().value!);
    return current;
}

/**
 * Strip terminal control sequences across socket-message boundaries. Returns
 * the visible text and appends it to the rolling tail. The tail is a chunk
 * list joined only when links are requested -- per frame this is one array
 * push, never a 24KB string rebuild and rescan.
 */
function appendVisible(state: TailState, input: string): string {
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
    if (visible !== '') {
        state.chunks.push(visible);
        state.length += visible.length;
        while (state.length > MAX_CHARS) {
            const excess = state.length - MAX_CHARS;
            const first = state.chunks[0]!;
            if (first.length > excess) {
                state.chunks[0] = first.slice(excess);
                state.length = MAX_CHARS;
                break;
            }
            state.chunks.shift();
            state.length -= first.length;
        }
    }
    return visible;
}

export function recordTerminalOutput(sessionId: string, base64: string): void {
    let bytes: Uint8Array;
    try { bytes = decodeBase64(base64); } catch { return; }
    const state = touch(sessionId);
    const visible = appendVisible(state, state.decoder.decode(bytes, { stream: true }));
    if (state.capturing) {
        state.screen = (state.screen + visible).slice(-MAX_SCREEN_CHARS);
        if (state.scanTimer !== undefined) clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => scanViewport(sessionId), SCROLL_SCAN_DEBOUNCE_MS);
        return;
    }
    // Not scrolling: the frame path is one boolean check. A chunk carrying a
    // URL (a dev server just announced itself, and at the live edge that URL
    // is on screen) schedules a single debounced chip refresh.
    if (visible.includes('http') && state.tailTimer === undefined) {
        state.tailTimer = setTimeout(() => {
            state.tailTimer = undefined;
            notifyLinks(sessionId);
        }, TAIL_NOTIFY_DEBOUNCE_MS);
    }
}

// ponytail: "in view" is whatever herdr repainted during the gesture, which
// relies on herdr sending a full repaint on scroll. The exact-but-heavier
// upgrade is a headless xterm buffer (@xterm/xterm is already a root
// dependency).
/**
 * A scroll gesture started: herdr repaints the whole screen per scroll and
 * those frames arrive through recordTerminalOutput, so capture them apart
 * from the rolling tail. The next gesture resets the capture, the debounced
 * scan runs once per gesture, and the chip follows what is on screen.
 */
export function beginViewportCapture(sessionId: string): void {
    const state = touch(sessionId);
    state.capturing = true;
    state.screen = '';
    if (state.scanTimer !== undefined) {
        clearTimeout(state.scanTimer);
        state.scanTimer = undefined;
    }
}

function scanViewport(sessionId: string): void {
    const state = tails.get(sessionId);
    if (state === undefined) return;
    state.capturing = false;
    state.scanTimer = undefined;
    const links = extractLinks(unwrapTerminalLinks(state.screen, state.columns));
    state.screen = '';
    if (links.length === state.viewportLinks.length && links.every((link, index) => link === state.viewportLinks[index])) return;
    state.viewportLinks = links;
    notifyLinks(sessionId);
}

export function clearTerminalOutput(sessionId: string): void {
    drop(sessionId);
}

export function setTerminalColumns(sessionId: string, columns: number): void {
    touch(sessionId).columns = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
}

// A visual wrap fills the terminal row; a hard newline usually does not. Join
// only full-width rows while already inside a URL, never arbitrary lines.
function unwrapTerminalLinks(text: string, columns: number): string {
    const lines = text.replace(/\r/g, '').split('\n');
    if (columns === 0 || lines.length === 1) return lines.join('\n');
    let result = lines[0] ?? '';
    for (let index = 1; index < lines.length; index++) {
        const previous = lines[index - 1] ?? '';
        const next = lines[index] ?? '';
        const insideUrl = /https?:\/\/[^\s"'`<>]*$/.test(result);
        const softWrap = insideUrl && previous.length === columns && /^[^\s"'`<>]/.test(next);
        result += `${softWrap ? '' : '\n'}${next}`;
    }
    return result;
}

/** Latest-first, deduped and canonical URLs from the given text. */
function extractLinks(text: string): string[] {
    if (!text.includes('http')) return [];
    const found: string[] = [];
    const seen = new Set<string>();
    const matches = [...text.matchAll(URL_PATTERN)];
    for (let index = matches.length - 1; index >= 0 && found.length < MAX_LINKS; index--) {
        const candidate = trimTrailingPunctuation(matches[index]![0]);
        if (candidate.length <= 12 || candidate.length > MAX_URL_CHARS || UNSAFE_URL_CHARS.test(candidate)) continue;
        try {
            const parsed = new URL(candidate);
            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '' || seen.has(parsed.href)) continue;
            seen.add(parsed.href);
            found.push(parsed.href);
        } catch {}
    }
    return found;
}

/** Latest-first, deduped and canonical URLs from the visible terminal tail. */
export function recentTerminalLinks(sessionId: string): string[] {
    const state = tails.get(sessionId);
    if (state === undefined) return [];
    touch(sessionId, state);
    return extractLinks(unwrapTerminalLinks(state.chunks.join(''), state.columns));
}

/** Links on screen after the last scroll gesture, latest first. */
export function viewportTerminalLinks(sessionId: string): string[] {
    return tails.get(sessionId)?.viewportLinks ?? [];
}
