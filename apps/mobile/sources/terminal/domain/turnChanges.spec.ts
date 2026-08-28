import { describe, expect, it } from 'vitest';
import { collectTurnChanges, getTurnAssignments } from './turnChanges';
import { Message, ToolCall } from '@/sync/typesMessage';

function toolCall(id: string, name: string, input: unknown, state: ToolCall['state'] = 'completed', details?: unknown): Message {
    return { kind: 'tool-call', id, localId: null, createdAt: 0, children: [], tool: { name, input, state, createdAt: 0, startedAt: null, completedAt: null, description: null, details } } as unknown as Message;
}
function userText(id: string): Message { return { kind: 'user-text', id, localId: null, createdAt: 0, text: 'hi' } as unknown as Message; }
function agentText(id: string): Message { return { kind: 'agent-text', id, localId: null, createdAt: 0, text: 'done' } as unknown as Message; }

describe('live changes summary flow', () => {
    it('groups completed edits by user turn and reports accurate file totals', () => {
        const messages = [
            agentText('a'),
            toolCall('e1', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'x\nline' }] }),
            toolCall('e2', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'y\ny', newText: 'z' }] }),
            toolCall('e3', 'edit', { path: 'src/b.ts', edits: [{ oldText: 'old', newText: 'new' }] }),
            userText('u1'),
            agentText('b'),
            toolCall('w1', 'write', { path: 'README.md', content: 'line1\nline2\n' }),
            toolCall('e4', 'edit', { path: 'src/c.ts', edits: [] }, 'completed', { patch: '--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n+extra line\n' }),
            userText('u2'),
        ];
        expect(getTurnAssignments(messages)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1]);
        const changes = collectTurnChanges(messages);
        expect(changes.size).toBe(2);
        const first = [...changes.get(0)!];
        expect(first.find((file) => file.filePath === 'src/a.ts')).toMatchObject({ fileName: 'a.ts', linesAdded: 3, linesRemoved: 3 });
        expect(first.find((file) => file.filePath === 'src/b.ts')?.linesAdded).toBe(1);
        const second = [...changes.get(1)!];
        expect(second.find((file) => file.filePath === 'README.md')).toMatchObject({ linesAdded: 2, linesRemoved: 0 });
        expect(second.find((file) => file.filePath === 'src/c.ts')).toMatchObject({ linesAdded: 2, linesRemoved: 1 });
    });

    it('does not create a visible change for incomplete, failed, non-edit, or empty tool calls', () => {
        const messages = [
            agentText('a'),
            toolCall('r', 'read', { path: 'a.ts' }),
            toolCall('running', 'edit', { path: 'b.ts', edits: [{ oldText: 'x', newText: 'y' }] }, 'running'),
            toolCall('failed', 'edit', { path: 'c.ts', edits: [{ oldText: 'x', newText: 'y' }] }, 'error'),
            toolCall('missing', 'edit', { edits: [{ oldText: 'x', newText: 'y' }] }),
            toolCall('empty', 'edit', { path: 'd.ts', edits: [] }),
            userText('u'),
        ];
        expect(collectTurnChanges(messages)).toEqual(new Map());
    });
});
