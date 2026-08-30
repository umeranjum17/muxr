import { describe, expect, it } from 'vitest';
import { FALLBACK_AGENT_KINDS } from '@/catalog/domain/agentKinds';
import { agentImageKind } from './agentImageKind';

describe('agent glyph image mapping flow', () => {
    it('backs every supported picker kind with an image and leaves unknown kinds on the initial fallback', () => {
        for (const kind of FALLBACK_AGENT_KINDS) {
            expect(agentImageKind(kind), `${kind} should resolve to an image`).toBeDefined();
        }
        expect(agentImageKind('unknown-provider')).toBeUndefined();
    });

    it('resolves alternate names to their canonical provider image', () => {
        expect(agentImageKind('antigravity')).toBe('antigravity');
        expect(agentImageKind('antigravity-cli')).toBe('antigravity');
        expect(agentImageKind('agy')).toBe('antigravity');
        expect(agentImageKind('kilocode')).toBe('kilocode');
        expect(agentImageKind('kilo')).toBe('kilocode');
        expect(agentImageKind('qoder')).toBe('qoder');
        expect(agentImageKind('qodercli')).toBe('qoder');
        expect(agentImageKind('shell')).toBe('shell');
        expect(agentImageKind('')).toBeUndefined();
    });
});
