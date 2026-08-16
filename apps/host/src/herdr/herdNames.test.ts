import { describe, expect, it } from 'vitest';
import { explicitHerdName, isGeneratedName, isGenericTabLabel, isPlaceholderLabel, pickHerdName } from './herdNames.js';

describe('pickHerdName', () => {
    it('never hands out a name already in the herd, case aside', () => {
        const taken: string[] = [];
        for (let i = 0; i < 40; i += 1) {
            const name = pickHerdName(taken);
            expect(taken.map((t) => t.toLowerCase())).not.toContain(name.toLowerCase());
            taken.push(i % 2 === 0 ? name.toUpperCase() : name);
        }
        expect(new Set(taken.map((t) => t.toLowerCase())).size).toBe(40);
    });

    it('treats herdr handles as unnamed but keeps names a human chose', () => {
        expect(isGeneratedName('pp_865b21fa')).toBe(true);
        expect(isGeneratedName(undefined)).toBe(true);
        expect(isGeneratedName('wake_writer')).toBe(false);
    });

    it('does not treat a first prompt as a name', () => {
        expect(isPlaceholderLabel('hi')).toBe(true);
        expect(isPlaceholderLabel('hello there')).toBe(true);
        expect(isPlaceholderLabel('please fix the login')).toBe(true);
        expect(isPlaceholderLabel('Falcon')).toBe(true);
        expect(isPlaceholderLabel('pi')).toBe(true);
        expect(isPlaceholderLabel('backend')).toBe(false);
        expect(isPlaceholderLabel('Write Tests')).toBe(false);
        expect(isPlaceholderLabel('Cursor - Plugin Dry Run')).toBe(false);
    });

    it('ignores default tab labels but preserves deliberate ones', () => {
        expect(isGenericTabLabel('1')).toBe(true);
        expect(isGenericTabLabel('pi')).toBe(true);
        expect(isGenericTabLabel('claude')).toBe(true);
        expect(isGenericTabLabel('backend')).toBe(false);
    });

    it('never lets a generic tab label hide an explicit agent name', () => {
        expect(explicitHerdName({ agentName: 'wake_writer', tabLabel: '1' })).toBe('wake_writer');
        expect(explicitHerdName({ paneLabel: 'API', agentName: 'wake_writer', tabLabel: 'review' })).toBe('API');
        expect(explicitHerdName({ agentName: 'pp_1234', tabLabel: 'backend' })).toBe('backend');
        expect(explicitHerdName({ agentName: 'pp_1234', tabLabel: 'pi' })).toBeUndefined();
        expect(explicitHerdName({ paneLabel: 'hi', agentName: 'pp_1234', tabLabel: 'pi' })).toBeUndefined();
        expect(explicitHerdName({ paneLabel: 'hi', tabLabel: 'backend' })).toBe('backend');
    });
});
