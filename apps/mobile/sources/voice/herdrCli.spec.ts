import { describe, expect, it } from 'vitest';
import { requiresHerdrConfirmation } from './herdrCli';

describe('requiresHerdrConfirmation', () => {
    it('guards destructive commands even with global herdr options', () => {
        expect(requiresHerdrConfirmation(['pane', 'close', 'w1:p2'])).toBe(true);
        expect(requiresHerdrConfirmation(['--session', 'main', 'worktree', 'remove', '/repo/wt'])).toBe(true);
        expect(requiresHerdrConfirmation(['plugin', 'pane', 'close', 'logs'])).toBe(true);
        expect(requiresHerdrConfirmation(['session', 'stop', 'main'])).toBe(true);
        expect(requiresHerdrConfirmation(['session', 'delete', 'main'])).toBe(true);
        expect(requiresHerdrConfirmation(['plugin', 'install', 'owner/repo'])).toBe(true);
        expect(requiresHerdrConfirmation(['plugin', 'uninstall', 'demo'])).toBe(true);
        expect(requiresHerdrConfirmation(['plugin', 'action', 'invoke', 'deploy'])).toBe(true);
        expect(requiresHerdrConfirmation(['integration', 'install', 'pi'])).toBe(true);
        expect(requiresHerdrConfirmation(['channel', 'set', 'preview'])).toBe(true);
        expect(requiresHerdrConfirmation(['pane', 'run', 'w1:p2', 'rm', '-rf', '/tmp/x'])).toBe(true);
        expect(requiresHerdrConfirmation(['pane', 'send-keys', 'w1:p2', 'C-c'])).toBe(true);
        expect(requiresHerdrConfirmation(['agent', 'send-keys', 'Otter', 'C-c'])).toBe(true);
        expect(requiresHerdrConfirmation(['update'])).toBe(true);
    });

    it('does not slow down reversible herd control', () => {
        expect(requiresHerdrConfirmation(['pane', 'focus', 'w1:p2'])).toBe(false);
        expect(requiresHerdrConfirmation(['pane', 'rename', 'w1:p2', 'Otter'])).toBe(false);
        expect(requiresHerdrConfirmation(['worktree', 'create', '--cwd', '/repo'])).toBe(false);
        expect(requiresHerdrConfirmation(['agent', 'prompt', 'Otter', 'please', 'update', 'the', 'docs'])).toBe(false);
    });
});
