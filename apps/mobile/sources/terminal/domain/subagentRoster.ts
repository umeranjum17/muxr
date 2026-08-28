/**
 * Reads Pi's `subagent` tool details into a per-child roster.
 *
 * A live run reports `progress[]`, a finished one reports `results[]`, and a
 * management call (`action: 'list' | 'status'`, fleet views) reports neither --
 * its answer is the tool text. Callers must render that text rather than an
 * empty roster, or the whole reply disappears.
 */

export interface RosterEntry {
    agent: string;
    status?: string;
    activity: string;
    /** Turns/tools/tokens/time: what says whether a quiet child is stuck or slow. */
    cost: string;
    /** Provider-qualified model id. Absent for a running child on its agent's own
     *  default: the progress snapshot carries no model, only the finished result does. */
    model?: string;
}

interface AgentProgress {
    agent?: string;
    status?: string;
    task?: string;
    currentTool?: string;
    currentToolArgs?: string;
    toolCount?: number;
    turnCount?: number;
    tokens?: number;
    durationMs?: number;
    error?: string;
}

interface SingleResult {
    agent?: string;
    task?: string;
    exitCode?: number;
    error?: string;
    model?: string;
    usage?: { turns?: number; input?: number; output?: number };
}

/** `input` is the tool's own arguments, which carry the parent's model override. */
export function subagentRoster(details: unknown, input?: unknown): RosterEntry[] {
    const record = details as { progress?: unknown; results?: unknown } | undefined;
    const asked = modelLabel((input as { model?: unknown } | undefined)?.model);
    if (Array.isArray(record?.progress) && record.progress.length > 0) {
        return (record.progress as AgentProgress[]).map((child) => entryOfProgress(child, asked));
    }
    if (!Array.isArray(record?.results)) return [];
    return (record.results as SingleResult[]).map((result) => entryOfResult(result, asked));
}

function entryOfProgress(child: AgentProgress, asked: string | undefined): RosterEntry {
    return {
        agent: child.agent ?? 'agent',
        ...(child.status === undefined ? {} : { status: child.status }),
        activity: progressActivity(child),
        cost: costLine(child.turnCount, child.toolCount, child.tokens, child.durationMs),
        ...(asked === undefined ? {} : { model: asked }),
    };
}

function entryOfResult(result: SingleResult, asked: string | undefined): RosterEntry {
    const failed = result.error !== undefined || (result.exitCode ?? 0) !== 0;
    const tokens = (result.usage?.input ?? 0) + (result.usage?.output ?? 0);
    // The result reports what actually ran, which a fallback can make differ from what was asked for.
    const model = modelLabel(result.model) ?? asked;
    return {
        agent: result.agent ?? 'agent',
        status: failed ? 'failed' : 'completed',
        activity: result.error ?? result.task ?? '',
        cost: costLine(result.usage?.turns, undefined, tokens, undefined),
        ...(model === undefined ? {} : { model }),
    };
}

/** Provider kept: `cursor/composer-2.5` and `openrouter/composer-2.5` are not the same run. */
function modelLabel(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const label = value.trim();
    return label === '' ? undefined : label;
}

function progressActivity(child: AgentProgress): string {
    if (child.error !== undefined && child.error !== '') return child.error;
    if (child.status !== 'running') return child.task ?? child.status ?? '';
    if (child.currentTool === undefined) return 'thinking';
    // The tool name alone reads the same for every child; the argument is what
    // distinguishes "bash yarn typecheck" from "bash git status".
    return child.currentToolArgs === undefined || child.currentToolArgs === ''
        ? child.currentTool
        : `${child.currentTool} ${child.currentToolArgs}`;
}

function costLine(turns?: number, tools?: number, tokens?: number, durationMs?: number): string {
    const parts: string[] = [];
    if (typeof turns === 'number') parts.push(`${String(turns)}t`);
    if (typeof tools === 'number') parts.push(`${String(tools)}⚒`);
    if (typeof tokens === 'number' && tokens > 0) parts.push(`${String(Math.round(tokens / 1000))}k`);
    if (typeof durationMs === 'number') parts.push(`${String(Math.round(durationMs / 1000))}s`);
    return parts.join(' ');
}
