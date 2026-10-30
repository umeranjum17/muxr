import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import type { ChatImage, ChatMessage, ChatTool, ChatToolKind } from '@trymuxr/contract';

export type ChatHarness = 'claude' | 'pi';

/** A message longer than this is cut: the phone shows a conversation, not a file dump. */
export const CHAT_TEXT_MAX = 20_000;
/** The newest this many messages go to the phone. */
export const CHAT_MESSAGES_MAX = 120;
/** A reply's tool calls past this many are dropped: the chips summarise, they do not log. */
const CHAT_TOOLS_MAX = 30;
const TOOL_DETAIL_MAX = 300;

/** Claude Code writes its own bookkeeping into the user turn; none of it is something the person said. */
const NOT_SPOKEN = /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)\b|\[Request interrupted by user)/;

interface Block { type?: unknown; text?: unknown; name?: unknown; id?: unknown; input?: unknown; arguments?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown; source?: unknown; data?: unknown; mimeType?: unknown }

/** Where an image's bytes are: in the log itself, or a file a reply named. */
export type ChatImageSource = { mimeType: string; data: string } | { path: string };
/** A message shows this many images at most. */
const IMAGES_MAX = 8;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** `![alt](target)`: the target a reply drew as an image. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** A path to an image file standing on its own in the text, bare or in code quotes. */
const IMAGE_PATH = /(?<=^|[\s`'"(\[])((?:\.{1,2}\/|\/)?[\w@%+~.-]+(?:\/[\w@%+~.-]+)*\.(?:png|jpe?g|gif|webp))(?=$|[\s`'")\],:;!?]|\.(?:\s|$))/gim;

export function imageTypeOf(path: string): string | undefined {
    return IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
}

/** The image blocks of a content array, in either harness's shape. */
function inlineImagesOf(content: unknown): Array<{ mimeType: string; data: string }> {
    if (!Array.isArray(content)) return [];
    return (content as Block[]).flatMap((block) => {
        if (block?.type !== 'image') return [];
        // Claude Code: `{ source: { type: 'base64', media_type, data } }`; Pi: `{ data, mimeType }`.
        const source = block.source as { media_type?: unknown; data?: unknown } | undefined;
        const mimeType = source?.media_type ?? block.mimeType;
        const data = source?.data ?? block.data;
        return typeof mimeType === 'string' && mimeType.startsWith('image/') && typeof data === 'string' && data !== '' ? [{ mimeType, data }] : [];
    });
}

/** The image files a reply names, as absolute paths, and its text with the local `![…](…)` it drew taken out. */
function imageFilesOf(text: string, cwd: string | undefined): { text: string; paths: string[] } {
    const paths = new Set<string>();
    const resolve = (target: string) => isAbsolute(target) ? target : cwd === undefined ? undefined : join(cwd, target);
    const kept = text.replace(MARKDOWN_IMAGE, (whole, target: string) => {
        const path = /^[a-z][a-z0-9+.-]*:/i.test(target) || imageTypeOf(target) === undefined ? undefined : resolve(target);
        if (path === undefined) return whole;
        paths.add(path);
        return '';
    });
    for (const [, target] of kept.matchAll(IMAGE_PATH)) {
        const path = resolve(target!);
        if (path !== undefined) paths.add(path);
    }
    return { text: kept.replace(/\n{3,}/g, '\n\n').trim(), paths: [...paths] };
}

/** Claude Code's and Pi's tool names, lower-cased, to the kind of step and what the person would say the agent did. */
const TOOL_KINDS: Record<string, [ChatToolKind, string]> = {
    read: ['read', 'Read a file'], notebookread: ['read', 'Read a file'],
    edit: ['edit', 'Edited a file'], multiedit: ['edit', 'Edited a file'], notebookedit: ['edit', 'Edited a file'], write: ['write', 'Wrote a file'],
    bash: ['run', 'Ran a command'],
    grep: ['search', 'Searched the code'], glob: ['search', 'Searched the code'], find: ['search', 'Searched the code'], ls: ['list', 'Listed a folder'],
    webfetch: ['fetch', 'Read a web page'], websearch: ['web', 'Searched the web'],
    task: ['helper', 'Started a helper'], agent: ['helper', 'Started a helper'],
    todowrite: ['plan', 'Updated the plan'], askuserquestion: ['ask', 'Asked you'],
};
/** The argument that says what a call was about, by the names both harnesses use. */
const DETAIL_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description'];
/** A peek, not the file: an edit keeps this many changed lines, a result this many. */
const DIFF_MAX = 40;
const OUTPUT_MAX = 6;
const LINE_MAX = 200;

type Args = Record<string, unknown> | undefined;
type Pending = ChatTool & { id?: string };
interface Result { text: string; failed: boolean; patch?: Hunk[]; helper?: HelperRun; images: Array<{ mimeType: string; data: string }> }
/** What Claude Code records of a helper's run beside its result. */
interface HelperRun { steps?: number; seconds?: number }
/** Claude Code's own record of an edit, beside its result: real line numbers. */
interface Hunk { oldStart: number; newStart: number; lines: string[] }

const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const linesOf = (text: unknown) => typeof text === 'string' ? text.split('\n') : [];

/** The lines an edit changed, with one unchanged line either side. */
function changeOf(before: string[], after: string[]): { diff: string[]; added: number; removed: number } {
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const removed = before.slice(head, before.length - tail);
    const added = after.slice(head, after.length - tail);
    const diff = [
        ...before.slice(Math.max(0, head - 1), head).map((line) => ` ${line}`),
        ...removed.map((line) => `-${line}`),
        ...added.map((line) => `+${line}`),
        ...before.slice(before.length - tail, before.length - tail + 1).map((line) => ` ${line}`),
    ];
    return { diff, added: added.length, removed: removed.length };
}

/** An Edit, MultiEdit or Write call's change, from its own arguments: the log holds no diff. */
function editOf(kind: ChatToolKind, args: Args): Pick<ChatTool, 'diff' | 'added' | 'removed'> {
    if (kind === 'write' && typeof args?.content === 'string') {
        const lines = linesOf(args.content.replace(/\n$/, ''));
        return { diff: lines.slice(0, DIFF_MAX).map((line) => cut(`+${line}`, LINE_MAX)), added: lines.length, removed: 0 };
    }
    const edits = Array.isArray(args?.edits) ? args.edits as Args[] : [args];
    const changes = edits.flatMap((edit) => {
        const before = edit?.old_string ?? edit?.oldText;
        const after = edit?.new_string ?? edit?.newText;
        return typeof before === 'string' && typeof after === 'string' ? [changeOf(linesOf(before), linesOf(after))] : [];
    });
    if (changes.length === 0) return {};
    return {
        diff: changes.flatMap((change) => change.diff).slice(0, DIFF_MAX).map((line) => cut(line, LINE_MAX)),
        added: changes.reduce((sum, change) => sum + change.added, 0),
        removed: changes.reduce((sum, change) => sum + change.removed, 0),
    };
}

function toolOf(block: Block, cwd: string | undefined): Pending | undefined {
    if ((block.type !== 'tool_use' && block.type !== 'toolCall') || typeof block.name !== 'string' || block.name === '') return undefined;
    // An MCP tool is `mcp__<server>__<tool>`: its own name is the last part.
    const name = block.name.split('__').at(-1) ?? block.name;
    const [kind, verb] = TOOL_KINDS[name.toLowerCase()] ?? ['tool', `Used ${name.replace(/[_-]+/g, ' ')}`];
    const args = (block.type === 'tool_use' ? block.input : block.arguments) as Args;
    const tool: Pending = { verb, kind, ...(typeof block.id === 'string' ? { id: block.id } : {}) };
    const value = DETAIL_KEYS.map((key) => args?.[key]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
    // A path inside the agent's folder reads from there: the phone never shows the home path above it.
    if (value !== undefined) tool.detail = cut(relativeTo(cwd, value.trim()), TOOL_DETAIL_MAX);
    if (kind === 'edit' || kind === 'write') Object.assign(tool, editOf(kind, args));
    if (kind === 'plan' && Array.isArray(args?.todos)) {
        const todos = (args.todos as Args[]).filter((todo) => typeof todo?.content === 'string');
        tool.note = `${todos.filter((todo) => todo?.status === 'completed').length} of ${todos.length} done`;
        tool.output = todos.slice(0, OUTPUT_MAX * 2).map((todo) => cut(`${todo?.status === 'completed' ? '✓' : '○'} ${String(todo?.content)}`, LINE_MAX));
    }
    return tool;
}

function relativeTo(cwd: string | undefined, value: string): string {
    return cwd !== undefined && value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value;
}

function toolsOf(content: unknown, cwd: string | undefined): Pending[] {
    if (!Array.isArray(content)) return [];
    return (content as Block[]).flatMap((block) => { const tool = toolOf(block ?? {}, cwd); return tool === undefined ? [] : [tool]; });
}

/** Every tool result in the log by the id of the call it answers: Claude's `tool_result` blocks, Pi's `toolResult` messages. */
function resultsOf(entries: Array<Record<string, unknown>>): Map<string, Result> {
    const results = new Map<string, Result>();
    for (const entry of entries) {
        const message = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown } | undefined;
        if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
            results.set(message.toolCallId, { text: textOf(message.content), failed: message.isError === true, images: inlineImagesOf(message.content) });
        } else if (message?.role === 'user' && Array.isArray(message.content)) {
            const answers = (message.content as Block[]).filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string');
            // The patch rides on the line, so it names the call only when the line answers one.
            const patch = answers.length === 1 ? hunksOf((entry.toolUseResult as { structuredPatch?: unknown } | undefined)?.structuredPatch) : undefined;
            const helper = answers.length === 1 ? helperRunOf(entry.toolUseResult) : undefined;
            for (const block of answers) results.set(block.tool_use_id as string, { text: textOf(block.content), failed: block.is_error === true, images: inlineImagesOf(block.content), ...(patch === undefined ? {} : { patch }), ...(helper === undefined ? {} : { helper }) });
        }
    }
    return results;
}

function helperRunOf(value: unknown): HelperRun | undefined {
    const run = value as { totalToolUseCount?: unknown; totalDurationMs?: unknown } | undefined;
    const helper: HelperRun = {};
    if (typeof run?.totalToolUseCount === 'number') helper.steps = run.totalToolUseCount;
    if (typeof run?.totalDurationMs === 'number') helper.seconds = Math.round(run.totalDurationMs / 1000);
    return helper.steps === undefined && helper.seconds === undefined ? undefined : helper;
}

/** A helper's status line: "7 steps · 1 min 12 s". */
function helperNote({ steps, seconds }: HelperRun): string {
    const parts: string[] = [];
    if (steps !== undefined) parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
    if (seconds !== undefined) parts.push(`${seconds >= 60 ? `${Math.floor(seconds / 60)} min ` : ''}${seconds % 60} s`);
    return parts.join(' · ');
}

function hunksOf(value: unknown): Hunk[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const hunks = (value as Array<Record<string, unknown>>).filter((hunk): hunk is Record<string, unknown> & Hunk => typeof hunk?.oldStart === 'number' && typeof hunk.newStart === 'number' && Array.isArray(hunk.lines));
    return hunks.length === 0 ? undefined : hunks;
}

/** A unified diff, its hunk headers kept so the phone can number the lines. */
function patchOf(hunks: Hunk[]): Pick<ChatTool, 'diff' | 'added' | 'removed'> {
    const lines = hunks.flatMap((hunk) => [`@@ -${hunk.oldStart} +${hunk.newStart} @@`, ...hunk.lines.filter((line) => typeof line === 'string')]);
    return {
        diff: lines.slice(0, DIFF_MAX).map((line) => cut(line, LINE_MAX)),
        added: lines.filter((line) => line.startsWith('+')).length,
        removed: lines.filter((line) => line.startsWith('-')).length,
    };
}

/** What a call came to, in the words and lines a peek shows. */
function withResult({ id, ...tool }: Pending, results: Map<string, Result>, cwd: string | undefined): ChatTool {
    const result = id === undefined ? undefined : results.get(id);
    if (result === undefined) return tool;
    let lines = result.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((line) => cwd === undefined ? line : line.split(`${cwd}/`).join('')).filter((line) => line.trim() !== '');
    const out: ChatTool = { ...tool, outcome: result.failed ? 'failed' : 'ok', ...(result.patch === undefined ? {} : patchOf(result.patch)) };
    if (tool.kind === 'helper') {
        // The helper's reply is its own card: one line of it, and how the run went.
        const reply = lines.find((line) => /\w/.test(line) && !line.trimStart().startsWith('#')) ?? lines.find((line) => /\w/.test(line));
        if (reply !== undefined) out.result = cut(reply.trim().replace(/^[#>*\-\s]+/, ''), LINE_MAX);
        if (result.helper !== undefined) out.note = helperNote(result.helper);
        return out;
    }
    if (tool.kind === 'run') {
        const code = /(?:exit code|exited with code)\s*(\d+)/i.exec(result.text)?.[1];
        if (code !== undefined || !result.failed) out.exit = code === undefined ? 0 : Number(code);
        lines = lines.filter((line) => !/^(?:exit code|command exited with code)\s*\d+$/i.test(line.trim()));
        out.output = lines.slice(-OUTPUT_MAX).map((line) => cut(line, LINE_MAX));
        return out;
    }
    if (result.failed || (tool.kind !== 'edit' && tool.kind !== 'write' && tool.kind !== 'plan')) {
        if (tool.kind === 'read' && !result.failed) {
            lines = lines.map((line) => line.replace(/^\s*\d+(?:→|\t)/, ''));
            // A read that returned only an image has its card beside it; a note would only crowd the file name.
            if (lines.length > 0 || result.images.length === 0) out.note = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
        }
        if (tool.kind === 'search' && !result.failed) {
            const found = /^Found (\d+) files?/.exec(lines[0] ?? '');
            if (lines.length === 0 || /^No (?:matches|files) found/.test(lines[0] ?? '')) { out.note = 'no matches'; lines = []; }
            else if (found !== null) { out.note = `${found[1]} file${found[1] === '1' ? '' : 's'}`; lines = lines.slice(1); }
            else out.note = `${lines.length} match${lines.length === 1 ? '' : 'es'}`;
        }
        out.output = lines.slice(0, OUTPUT_MAX).map((line) => cut(line, LINE_MAX));
    }
    return out;
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return (content as Block[])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n\n');
}

type Parsed = Omit<ChatMessage, 'tools' | 'images'> & { group: string; tools?: Pending[]; pasted: Array<{ mimeType: string; data: string }> };

function clip(text: string): string {
    return text.length > CHAT_TEXT_MAX ? `${text.slice(0, CHAT_TEXT_MAX)}…` : text;
}

/**
 * One log line to the message it carries, if it carries one. A tool result,
 * a thinking block and the harness's own bookkeeping carry none; a reply's
 * tool calls ride on it as chips.
 */
function parseEntry(harness: ChatHarness, entry: Record<string, unknown>, cwd: string | undefined): Parsed | undefined {
    const message = entry.message as { id?: unknown; role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
    if (typeof message !== 'object' || message === null) return undefined;
    if (harness === 'claude' && (entry.isSidechain === true || entry.isMeta === true)) return undefined;
    // A turn Claude Code raises itself (a finished background task) names its origin; a person's own says `human`.
    const origin = entry.origin as { kind?: unknown } | undefined;
    if (harness === 'claude' && typeof origin?.kind === 'string' && origin.kind !== 'human') return undefined;
    if (harness === 'pi' && entry.type !== 'message') return undefined;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return undefined;
    const text = textOf(message.content).trim();
    const tools = role === 'assistant' ? toolsOf(message.content, cwd) : [];
    const pasted = inlineImagesOf(message.content);
    if ((text === '' && tools.length === 0 && pasted.length === 0) || (role === 'user' && NOT_SPOKEN.test(text))) return undefined;
    const stamp = message.timestamp ?? entry.timestamp;
    const at = typeof stamp === 'number' ? stamp : Date.parse(String(stamp));
    if (!Number.isFinite(at)) return undefined;
    const id = String((harness === 'claude' ? entry.uuid : entry.id) ?? '');
    if (id === '') return undefined;
    // Claude Code writes one line per content block of a reply, all under the reply's id.
    const group = harness === 'claude' && role === 'assistant' && typeof message.id === 'string' ? message.id : id;
    return { id: group, group, role, text, at, pasted, ...(tools.length > 0 ? { tools } : {}) };
}

/**
 * The conversation in a session log, oldest first, one entry per message.
 * `cwd` is the agent's folder: paths inside it read from there. Each image
 * a message carries is filed in `images` under the id the message gives it.
 */
export function chatMessagesFrom(harness: ChatHarness, lines: Iterable<string>, cwd?: string, images?: Map<string, ChatImageSource>): ChatMessage[] {
    const entries: Array<Record<string, unknown>> = [];
    for (const line of lines) {
        try { const entry: unknown = JSON.parse(line); if (typeof entry === 'object' && entry !== null) entries.push(entry as Record<string, unknown>); } catch { /* a torn or foreign line */ }
    }
    const results = resultsOf(entries);
    const out: Parsed[] = [];
    let last: Parsed | undefined;
    for (const entry of entries) {
        const parsed = parseEntry(harness, entry, cwd);
        if (parsed === undefined) continue;
        if (last !== undefined && last.group === parsed.group && last.role === parsed.role) {
            if (parsed.text !== '') last.text = last.text === '' ? parsed.text : `${last.text}\n\n${parsed.text}`;
            if (parsed.tools !== undefined) last.tools = [...(last.tools ?? []), ...parsed.tools];
            last.pasted.push(...parsed.pasted);
            continue;
        }
        last = parsed;
        out.push(parsed);
    }
    return out.map(({ group: _group, tools, pasted, ...message }) => {
        const shown = tools?.slice(0, CHAT_TOOLS_MAX);
        const files = message.role === 'assistant' ? imageFilesOf(message.text, cwd) : { text: message.text, paths: [] };
        const sources: Array<[string, ChatImageSource]> = [
            ...pasted.map((image, index): [string, ChatImageSource] => [`${message.id}.${index}`, image]),
            ...(shown ?? []).flatMap((tool) => (tool.id === undefined ? [] : results.get(tool.id)?.images ?? []).map((image, index): [string, ChatImageSource] => [`${tool.id}.${index}`, image])),
            ...files.paths.map((path): [string, ChatImageSource] => [`f${createHash('sha256').update(path).digest('hex').slice(0, 16)}`, { path }]),
        ].slice(0, IMAGES_MAX);
        for (const [id, source] of sources) images?.set(id, source);
        const shownImages: ChatImage[] = sources.map(([id, source]) => ({ id, name: 'path' in source ? basename(source.path) : 'Image' }));
        return {
            ...message,
            text: clip(files.text),
            ...(shown === undefined ? {} : { tools: shown.map((tool) => withResult(tool, results, cwd)) }),
            ...(shownImages.length > 0 ? { images: shownImages } : {}),
        };
    });
}
