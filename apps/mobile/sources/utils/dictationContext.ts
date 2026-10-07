import { storage } from '@/catalog/store';
import { agentLabels } from '@/herd/domain/agentPresentation';

/**
 * Per-turn biasing for on-device dictation.
 *
 * The kit assembles the final decode prompt as
 * `[engineInitialPrompt, ...engineVocabulary, perCallPrompt, ...perCallKeywords, previousTail]`
 * (`whisperDecodeOptions` in @byokit/dictation), while live preview readings
 * get no prompt at all. So only the per-call prompt/keywords below steer the
 * settled transcript; they ride on every turn via `listen({ prompt, keywords })`.
 *
 * whisper.cpp decodes the initial prompt inside a bounded context window, so
 * the assembled prompt must stay around 224 tokens (~896 chars at 4
 * chars/token). Names go first and most distinctive first: anything cut off
 * the tail is the generic tail, never a proper name.
 */
export const DICTATION_BIAS_BUDGET = {
    /** Hard cap on the assembled per-call contribution, ~224 tokens. */
    maxTotalChars: 896,
    /** At most this many keyword entries; the distinctive ones are first. */
    maxKeywords: 24,
    /** Longer names are split into words instead of carried whole. */
    maxKeywordChars: 32,
    /** Recent composer/pane text rides as the prompt tail, mirroring the kit. */
    maxPromptChars: 200,
} as const;

/** Product names the captain dictates, most distinctive first. */
export const BASE_DICTATION_NAMES = [
    'muxr',
    'Herdr',
    'Crewhouse',
    'Treehouse',
    'OpenClaw',
    'ChatGPT',
    'Codex',
    'Claude',
    'BYOKit',
    'worktree',
    'npm',
];

function isPaneId(word: string): boolean {
    // Pane ids read `pp_<hex>`; strip the prefix and the bare-hex rule
    // already used for other id shapes drops the rest.
    return /^[0-9a-f-]{8,}$/i.test(word.replace(/^pp_/i, ''));
}

function pushWord(out: string[], seen: Set<string>, word: string): void {
    const key = word.toLowerCase();
    if (word.length < 3 || seen.has(key)) return;
    // Ids, counts and paths steer nothing; a bare version or uuid only burns budget.
    if (/^\d+$/.test(word) || isPaneId(word)) return;
    if (out.length >= DICTATION_BIAS_BUDGET.maxKeywords) return;
    seen.add(key);
    out.push(word);
}

/** One source string becomes a whole name, or its words when it is a sentence. */
function addName(out: string[], seen: Set<string>, value: string | null | undefined): void {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('~')) return;
    if (trimmed.length <= DICTATION_BIAS_BUDGET.maxKeywordChars) {
        // Counts ride out of short titles; the words around them stay whole.
        // A title with nothing left after that names no one, so it is dropped.
        if (/\s/.test(trimmed)) {
            const kept = trimmed.split(/\s+/).filter((word) => !/\d/.test(word) && !isPaneId(word));
            if (kept.length === 0) return;
            pushWord(out, seen, kept.join(' '));
            return;
        }
        pushWord(out, seen, trimmed);
        return;
    }
    for (const word of trimmed.split(/[^a-zA-Z0-9_'-]+/u)) pushWord(out, seen, word);
}

function basename(path: string | null | undefined): string | undefined {
    const trimmed = path?.trim();
    if (!trimmed) return undefined;
    const parts = trimmed.split('/').filter(Boolean);
    return parts.at(-1);
}

export type DictationBiasInput = {
    agentNames?: ReadonlyArray<string | null | undefined>;
    taskTitles?: ReadonlyArray<string | null | undefined>;
    repoNames?: ReadonlyArray<string | null | undefined>;
    pathNames?: ReadonlyArray<string | null | undefined>;
    homeNames?: ReadonlyArray<string | null | undefined>;
    recentText?: string | null | undefined;
    hint?: string | null | undefined;
};

export type DictationBias = {
    keywords: string[];
    /** Recent text as the prompt tail; absent when there is nothing to carry. */
    prompt?: string;
};

/** Pure assembly: names first and most distinctive first, within budget. */
export function buildDictationBias(input: DictationBiasInput): DictationBias {
    const keywords: string[] = [];
    const seen = new Set<string>();
    for (const name of BASE_DICTATION_NAMES) pushWord(keywords, seen, name);
    for (const names of [input.agentNames, input.taskTitles, input.repoNames, input.pathNames, input.homeNames]) {
        for (const name of names ?? []) addName(keywords, seen, name);
    }
    const recent = [input.hint?.trim(), input.recentText?.trim()].filter(Boolean).join(' ');
    const prompt = recent ? recent.slice(-DICTATION_BIAS_BUDGET.maxPromptChars) : undefined;
    return prompt === undefined ? { keywords } : { keywords, prompt };
}

/** Per-turn context from the live catalog: the focused/viewed agent first. */
export function currentDictationContext(draftText?: string, hint?: string): DictationBias {
    const state = storage.getState() as {
        sessions?: Record<string, { metadata?: Record<string, unknown> | null }>;
        herdrWorkspaces?: ReadonlyArray<{
            label?: string;
            focused?: boolean;
            worktree?: { repo?: string };
            tabs?: ReadonlyArray<{
                label?: string;
                focused?: boolean;
                panes?: ReadonlyArray<{
                    sessionId?: string;
                    focused?: boolean;
                    cwd?: string;
                    agentName?: string;
                    taskTitle?: string;
                }>;
            }>;
        }>;
        homeSnapshot?: { workspaces?: ReadonlyArray<{ label?: string }> } | null;
        currentViewingSessionId?: string | null;
    };
    const sessions = state.sessions ?? {};
    const workspaces = state.herdrWorkspaces ?? [];
    const focusedWorkspace = workspaces.find((workspace) => workspace.focused);
    const focusedTab = focusedWorkspace?.tabs?.find((tab) => tab.focused)
        ?? workspaces.flatMap((workspace) => workspace.tabs ?? []).find((tab) => tab.focused);
    const focusedPane = focusedTab?.panes?.find((pane) => pane.focused);
    const viewingId = state.currentViewingSessionId ?? focusedPane?.sessionId;
    const viewing = (viewingId !== undefined && viewingId !== null) ? sessions[viewingId] : undefined;
    const metadata = (viewing?.metadata ?? {}) as {
        summary?: { text?: string };
        path?: string;
        workspaceLabel?: string;
        worktree?: { repo?: string };
    };

    // agentStatus/promptable only satisfy the label input; labels never read them.
    const labels = focusedPane !== undefined
        ? agentLabels({ ...focusedPane, agentStatus: 'unknown', promptable: false })
        : undefined;
    const hasAgent = (focusedPane?.agentName?.trim() ?? '') !== '';
    return buildDictationBias({
        // Never bias the 'Shell'/'Unnamed agent' placeholders: they name no one.
        agentNames: hasAgent ? [focusedPane?.agentName, labels?.agentName] : [],
        taskTitles: [labels?.task, labels?.title, focusedPane?.taskTitle, metadata.summary?.text],
        repoNames: [metadata.worktree?.repo, focusedWorkspace?.worktree?.repo, metadata.workspaceLabel],
        pathNames: [basename(metadata.path), basename(focusedPane?.cwd)],
        homeNames: [
            ...workspaces.map((workspace) => workspace.label),
            ...workspaces.flatMap((workspace) => (workspace.tabs ?? []).map((tab) => tab.label)),
            ...(state.homeSnapshot?.workspaces ?? []).map((workspace) => workspace.label),
        ],
        recentText: draftText,
        hint,
    });
}
