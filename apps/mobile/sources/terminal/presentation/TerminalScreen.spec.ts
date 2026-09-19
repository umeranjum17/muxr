import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The terminal header carries exactly one pane chevron: the 1/N pager's. The
 * title control once ended in its own chevron-down, which sat directly beside
 * the pager's and read as a duplicate (captain, 2026-09-19) — this guard keeps
 * it from coming back.
 */
const source = readFileSync(join(import.meta.dirname, 'TerminalScreen.tsx'), 'utf8');

describe('terminal header pane chevron', () => {
    it('shows exactly one chevron beside the 1/N count and none on the title control', () => {
        const headerStart = source.indexOf('<HeaderBackButton');
        const headerEnd = source.indexOf('{hasStatusRow &&', headerStart);
        expect(headerStart).toBeGreaterThan(-1);
        expect(headerEnd).toBeGreaterThan(headerStart);
        const header = source.slice(headerStart, headerEnd);

        expect(header.match(/chevron-down/g)?.length).toBe(1);

        const titleStart = source.indexOf('setTreeOpen(true)');
        const titleEnd = source.indexOf('</Pressable>', titleStart);
        expect(source.slice(titleStart, titleEnd).includes('chevron-down')).toBe(false);

        const pagerStart = source.indexOf('Open panes');
        const pagerEnd = source.indexOf('</Pressable>', pagerStart);
        expect(pagerStart).toBeGreaterThan(-1);
        expect(source.slice(pagerStart, pagerEnd)).toContain('chevron-down');
    });
});
