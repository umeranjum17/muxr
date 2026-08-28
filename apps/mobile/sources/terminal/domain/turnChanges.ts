/**
 * Per-turn file change aggregation for the "changed files" card shown after an
 * agent turn.
 *
 * Counts completed `edit` / `write` tool calls per turn (Pi's tool names, see
 * knownTools.tsx). Pi's `edit` tool returns a unified patch in `details.patch`
 * when the running build provides one; otherwise counts come from the edit
 * fragments (oldText → newText). A `write` rewrites the whole file, so its
 * content length is the addition count.
 */

import { Message, ToolCall } from '@/sync/typesMessage';
import { getPatchDiffStats } from '@/components/diff/calculateDiff';

export interface TurnFileChange {
    filePath: string;
    fileName: string;
    linesAdded: number;
    linesRemoved: number;
}

const EDIT_TOOL_NAMES = new Set(['edit', 'write']);

/** Line count matching git's view: a trailing newline is not a line. */
function lineCount(text: string): number {
    if (text === '') return 0;
    const lines = text.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function getArg(tool: ToolCall, key: string): unknown {
    return typeof tool.input === 'object' && tool.input !== null
        ? (tool.input as Record<string, unknown>)[key]
        : undefined;
}

function toolStats(tool: ToolCall): { additions: number; deletions: number } | null {
    // Prefer Pi's own unified patch when present — the real diff is more
    // accurate than re-deriving counts from the edit fragments.
    const details = typeof tool.details === 'object' && tool.details !== null
        ? (tool.details as Record<string, unknown>)
        : null;
    const patch = details?.patch;
    if (typeof patch === 'string' && patch.trim() !== '') {
        return getPatchDiffStats(patch);
    }

    if (tool.name === 'write') {
        const content = getArg(tool, 'content');
        if (typeof content !== 'string') return null;
        // ponytail: a write rewrites the whole file, so removals aren't
        // knowable client-side without the pre-write contents.
        return { additions: lineCount(content), deletions: 0 };
    }

    const edits = getArg(tool, 'edits');
    if (!Array.isArray(edits)) return null;
    let additions = 0;
    let deletions = 0;
    for (const edit of edits) {
        if (typeof edit !== 'object' || edit === null) continue;
        const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
        if (typeof oldText === 'string') deletions += lineCount(oldText);
        if (typeof newText === 'string') additions += lineCount(newText);
    }
    return { additions, deletions };
}

function fileNameOf(filePath: string): string {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
}

/**
 * Newest-first messages → turn number (0 = current turn), one entry per message.
 * Shared with the display pipeline so the card lands on the same boundaries.
 */
export function getTurnAssignments(messages: Message[]): number[] {
    const turnOf = new Array<number>(messages.length);
    let turn = 0;
    for (let i = 0; i < messages.length; i++) {
        turnOf[i] = turn;
        if (messages[i].kind === 'user-text') turn++;
    }
    return turnOf;
}

export interface FileEdit {
    /** Tool-call message id — stable, used to dedupe when transcripts repage. */
    toolCallId: string;
    filePath: string;
    fileName: string;
    linesAdded: number;
    linesRemoved: number;
    /** Pi's unified patch when provided, or a synthesized one for whole-file
        writes. Lets the file viewer show the actual change even after the
        tree was committed (git diff is empty by then). */
    patch?: string;
}

/** Patch payloads beyond this are dropped rather than persisted. */
const MAX_PATCH_CHARS = 64 * 1024;

function patchOf(tool: ToolCall, fileName: string): string | undefined {
    const details = typeof tool.details === 'object' && tool.details !== null
        ? (tool.details as Record<string, unknown>)
        : null;
    if (typeof details?.patch === 'string' && details.patch.trim() !== '' && details.patch.length <= MAX_PATCH_CHARS) {
        return details.patch;
    }
    if (tool.name === 'write') {
        const content = getArg(tool, 'content');
        if (typeof content !== 'string' || content.length > MAX_PATCH_CHARS) return undefined;
        const lines = content.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        const body = lines.map((l) => `+${l}`).join('\n');
        return `--- /dev/null\n+++ b/${fileName}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
    }
    return undefined;
}

/**
 * One entry per completed edit/write tool call. The session changes pill
 * accumulates these into a persisted per-session map, so the list survives
 * reloads and transcript paging instead of depending on git timing.
 */
export function extractFileEdits(messages: Message[]): FileEdit[] {
    const out: FileEdit[] = [];
    for (const msg of messages) {
        if (msg.kind !== 'tool-call') continue;
        const tool = msg.tool;
        if (tool.state !== 'completed' || !EDIT_TOOL_NAMES.has(tool.name)) continue;
        const rawPath = getArg(tool, 'path');
        if (typeof rawPath !== 'string' || rawPath.trim() === '') continue;
        const stats = toolStats(tool);
        if (stats === null || (stats.additions === 0 && stats.deletions === 0)) continue;
        const filePath = rawPath.trim();
        const patch = patchOf(tool, fileNameOf(filePath));
        out.push({
            toolCallId: msg.id,
            filePath,
            fileName: fileNameOf(filePath),
            linesAdded: stats.additions,
            linesRemoved: stats.deletions,
            ...(patch === undefined ? {} : { patch }),
        });
    }
    return out;
}

/** Files touched by completed edit/write calls, keyed by turn number. Turns without edits are absent. */
export function collectTurnChanges(messages: Message[]): Map<number, TurnFileChange[]> {
    const byTurn = new Map<number, Map<string, TurnFileChange>>();
    const turnOf = getTurnAssignments(messages);

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.kind !== 'tool-call') continue;
        const tool = msg.tool;
        if (tool.state !== 'completed' || !EDIT_TOOL_NAMES.has(tool.name)) continue;
        const rawPath = getArg(tool, 'path');
        if (typeof rawPath !== 'string' || rawPath.trim() === '') continue;
        const stats = toolStats(tool);
        if (stats === null || (stats.additions === 0 && stats.deletions === 0)) continue;

        const filePath = rawPath.trim();
        let files = byTurn.get(turnOf[i]);
        if (!files) {
            files = new Map();
            byTurn.set(turnOf[i], files);
        }
        const existing = files.get(filePath);
        if (existing) {
            existing.linesAdded += stats.additions;
            existing.linesRemoved += stats.deletions;
        } else {
            files.set(filePath, {
                filePath,
                fileName: fileNameOf(filePath),
                linesAdded: stats.additions,
                linesRemoved: stats.deletions,
            });
        }
    }

    const result = new Map<number, TurnFileChange[]>();
    for (const [turn, files] of byTurn) {
        result.set(turn, [...files.values()]);
    }
    return result;
}
