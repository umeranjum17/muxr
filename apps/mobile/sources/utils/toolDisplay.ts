import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { rigCanReadFiles } from '@/sync/rig';

/**
 * Coarse buckets for the collapsed group header ("ran 3 commands", "read 2
 * files"). Pi's builtin names are exact; anything from an plugin or MCP
 * server falls in 'other', which reads fine in a summary.
 */

const TERMINAL_TOOL_NAMES = new Set(['bash']);
const EDIT_TOOL_NAMES = new Set(['edit', 'write']);
const READ_TOOL_NAMES = new Set(['read', 'ls']);
const SEARCH_TOOL_NAMES = new Set(['grep', 'find', 'web_search', 'source_check']);
const WEB_TOOL_NAMES = new Set(['fetch_content', 'agent_browser', 'get_search_content']);
const TASK_TOOL_NAMES = new Set(['subagent', 'subagent_wait']);

export type ToolSummaryCategory = 'terminal' | 'edit' | 'read' | 'search' | 'web' | 'task' | 'other';

export function isTerminalToolName(name: string): boolean {
    return TERMINAL_TOOL_NAMES.has(name);
}

export function isFileEditToolName(name: string): boolean {
    return EDIT_TOOL_NAMES.has(name);
}

/**
 * The file a tool card opens, or null when it should fall through to the message
 * detail instead.
 *
 * The capability check belongs here rather than at each call site: the file
 * route reads through `sessionReadFile`, which a session without file access
 * answers with an error alert, so offering the tap at all is the bug.
 */
export function toolFilePath(
    metadata: Metadata | null | undefined,
    tool: Pick<ToolCall, 'name' | 'input'>,
): string | null {
    if (!isFileEditToolName(tool.name) || !rigCanReadFiles(metadata)) return null;
    const path = (tool.input as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' && path.trim() !== '' ? path : null;
}

export function getToolSummaryCategory(toolName: string): ToolSummaryCategory {
    if (TERMINAL_TOOL_NAMES.has(toolName)) return 'terminal';
    if (EDIT_TOOL_NAMES.has(toolName)) return 'edit';
    if (READ_TOOL_NAMES.has(toolName)) return 'read';
    if (SEARCH_TOOL_NAMES.has(toolName)) return 'search';
    if (WEB_TOOL_NAMES.has(toolName)) return 'web';
    if (TASK_TOOL_NAMES.has(toolName)) return 'task';
    return 'other';
}

/** The one argument worth showing next to a tool name, by Pi's conventions. */
const DETAIL_KEYS = ['command', 'path', 'pattern', 'url', 'query', 'claim', 'task', 'agent', 'title'];

export function getToolSummaryDetail(tool: Pick<ToolCall, 'name' | 'input' | 'description'>): string | null {
    const input = tool.input as Record<string, unknown> | undefined;
    for (const key of DETAIL_KEYS) {
        const value = input?.[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return tool.description?.trim() || null;
}
