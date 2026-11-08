import { createHash } from 'node:crypto';

/** Adapt Codex's persisted response items to the message/tool shape shared by the chat readers. */
type Entry = Record<string, unknown>;
const CONTEXT = /^\s*(?:# AGENTS\.md instructions for |<environment_context>|<permissions instructions>|<turn_aborted>)/;

function object(value: unknown): Entry | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Entry : undefined;
}

function argumentsOf(value: unknown): Entry {
    if (typeof value !== 'string') return object(value) ?? {};
    try { return object(JSON.parse(value)) ?? {}; } catch { return {}; }
}

function contentOf(value: unknown): Entry[] {
    if (typeof value === 'string') return [{ type: 'text', text: value }];
    if (!Array.isArray(value)) return [];
    return value.flatMap<Entry>((block) => {
        const item = object(block);
        if ((item?.type === 'input_text' || item?.type === 'output_text') && typeof item.text === 'string') return [{ type: 'text', text: item.text }];
        if (item?.type === 'input_image' && typeof item.image_url === 'string') {
            const image = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(item.image_url);
            if (image !== null) return [{ type: 'image', mimeType: image[1], data: image[2] }];
        }
        return [];
    });
}

/** Custom exec output can contain structured command replies inside its text blocks. */
function resultOf(value: unknown): { content: Entry[]; isError: boolean } {
    const content = contentOf(value);
    let isError = false;
    const decoded = content.map((block) => {
        if (typeof block.text !== 'string') return block;
        const reply = argumentsOf(block.text);
        if (typeof reply.exit_code === 'number' && reply.exit_code !== 0) isError = true;
        if (typeof reply.output === 'string') return { type: 'text', text: `${reply.output}\nExit code ${reply.exit_code ?? 0}` };
        if (/^(?:exit code|Process exited with code)\s*:?\s*[1-9]\d*/im.test(block.text)) isError = true;
        return { ...block, text: block.text.replace(/^Process exited with code (\d+)$/gm, 'Exit code $1') };
    });
    return { content: decoded, isError };
}

export function codexChatEntries(entries: Entry[]): Entry[] {
    return entries.flatMap<Entry>((entry) => {
        if (entry.type !== 'response_item') return [];
        const item = object(entry.payload);
        if (item === undefined) return [];
        const id = String(item.id ?? item.call_id ?? createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 20));
        const base = { type: 'message', id, timestamp: entry.timestamp };
        if (item.type === 'message') {
            if (item.role !== 'user' && item.role !== 'assistant') return [];
            const content = contentOf(item.content);
            const text = content.map((block) => block.text ?? '').join('\n');
            if (item.role === 'user' && CONTEXT.test(text)) return [];
            return [{ ...base, message: { role: item.role, content } }];
        }
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            if (typeof item.name !== 'string' || typeof item.call_id !== 'string') return [];
            const args = argumentsOf(item.arguments);
            let name = item.name.split('.').at(-1)!;
            if (['exec_command', 'shell_command', 'shell'].includes(name)) {
                name = 'bash';
                args.command = args.cmd ?? args.command;
                if (Array.isArray(args.command)) args.command = args.command.join(' ');
            } else if (name === 'exec' || name === 'wait') {
                name = 'bash';
                // The complete script and output remain in the raw terminal.
                args.command = item.name.endsWith('exec') ? 'Script' : 'Script result';
            } else if (typeof item.input === 'string') args.description = item.input;
            return [{ ...base, message: { role: 'assistant', content: [{ type: 'toolCall', id: item.call_id, name, arguments: args }] } }];
        }
        if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
            if (typeof item.call_id !== 'string') return [];
            return [{ ...base, message: { role: 'toolResult', toolCallId: item.call_id, ...resultOf(item.output) } }];
        }
        return [];
    });
}
