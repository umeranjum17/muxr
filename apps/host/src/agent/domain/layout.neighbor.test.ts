import { describe, expect, it } from 'vitest';
import { neighborId } from './layout.js';

const TABS = ['tab-a', 'tab-b', 'tab-c'];

describe('neighborId', () => {
    it('moves to the adjacent entry', () => {
        expect(neighborId(TABS, 'tab-a', 'next')).toBe('tab-b');
        expect(neighborId(TABS, 'tab-b', 'next')).toBe('tab-c');
        expect(neighborId(TABS, 'tab-b', 'prev')).toBe('tab-a');
    });

    it('wraps around at both ends', () => {
        expect(neighborId(TABS, 'tab-c', 'next')).toBe('tab-a');
        expect(neighborId(TABS, 'tab-a', 'prev')).toBe('tab-c');
    });

    it('no-ops on a single entry or a missing current id', () => {
        expect(neighborId(['only'], 'only', 'next')).toBeUndefined();
        expect(neighborId(TABS, 'gone', 'next')).toBeUndefined();
        expect(neighborId([], 'gone', 'prev')).toBeUndefined();
    });
});
