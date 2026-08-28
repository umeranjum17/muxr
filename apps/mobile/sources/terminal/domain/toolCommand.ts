import type { ToolCall } from '@/catalog/infrastructure/typesMessage';

const SHELL_WRAPPERS = new Set([
    'bash',
    '/bin/bash',
    'sh',
    '/bin/sh',
    'zsh',
    '/bin/zsh',
]);

export function stringifyToolCommand(command: unknown): string | null {
    if (typeof command === 'string') {
        const trimmed = command.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    if (!Array.isArray(command)) {
        return null;
    }

    const parts = command
        .filter((part): part is string => typeof part === 'string')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (parts.length === 0) {
        return null;
    }

    if (parts.length >= 3 && SHELL_WRAPPERS.has(parts[0]) && (parts[1] === '-c' || parts[1] === '-lc')) {
        const wrappedCommand = parts.slice(2).join(' ').trim();
        return wrappedCommand.length > 0 ? wrappedCommand : null;
    }

    return parts.join(' ');
}

/**
 * The CLI line a tool call stands for, or null if it is not a CLI call.
 *
 * Drives the compact one-line transcript row: the command says everything the
 * header would, so the output belongs in the detail route rather than inline.
 * `agent_browser` qualifies through its `args` mode -- its other modes (job, qa,
 * batch) take structured objects, and those keep the generic input/output card.
 */
export function getPiCommand(tool: Pick<ToolCall, 'name' | 'input'>): string | null {
    const input = tool.input as { command?: unknown; args?: unknown } | undefined;
    if (tool.name === 'bash') return stringifyToolCommand(input?.command);
    if (tool.name === 'agent_browser') return stringifyToolCommand(input?.args);
    return null;
}
