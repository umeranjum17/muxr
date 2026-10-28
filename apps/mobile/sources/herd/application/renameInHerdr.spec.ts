import { describe, expect, it } from 'vitest';
import { agentHandle, renamedTo } from '../domain/agentPresentation';

describe('rename sheet', () => {
    it('types an agent name into Herdr handle form and sends nothing for a cancelled, blank or unchanged entry', () => {
        expect(agentHandle('Auth Fixer!')).toBe('auth-fixer');
        expect(agentHandle('Ünïcode_Bot 2')).toBe('ncode_bot-2');

        expect(renamedTo(null, 'Review')).toBeNull();
        expect(renamedTo('   ', 'Review')).toBeNull();
        expect(renamedTo(' Review ', 'Review')).toBeNull();
        expect(renamedTo(' Dev server ', 'Review')).toBe('Dev server');
    });
});
