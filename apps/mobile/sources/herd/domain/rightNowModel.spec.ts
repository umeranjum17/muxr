import { describe, expect, it } from 'vitest';
import { asRightNowPayload, vitalsFacts } from './rightNowModel';

/** The card's contract end to end: the host's typed payload survives the
 *  bounded parser with its figures, and junk degrades to the quiet state
 *  instead of crashing Home. */
describe('right now payload', () => {
    it('keeps the host payload the card renders', () => {
        const payload = asRightNowPayload({
            limits: { verdict: 'watch', windows: [{ label: 'Weekly limit', window: '7d', used: 78, resetsIn: '4d 17h', elapsed: 0.61 }] },
            vitals: {
                memoryUsed: 56_375_000_000, memoryTotal: 98_784_000_000,
                diskUsed: 431_600_000_000, diskTotal: 998_000_000_000,
                load1: 5.27, uptimeSeconds: 425_000,
            },
        });
        expect(payload.limits.verdict).toBe('watch');
        expect(payload.limits.windows).toEqual([{ label: 'Weekly limit', window: '7d', used: 78, resetsIn: '4d 17h', elapsed: 0.61 }]);
        expect(payload.collecting).toBeUndefined();
        expect(vitalsFacts(payload.vitals!)).toEqual({ memoryPercent: 57, diskPercent: 43, load: '5.3', uptime: '4d' });
    });

    it('reads the collecting fallback', () => {
        const collecting = asRightNowPayload({ collecting: true, vitals: { memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2, load1: 0, uptimeSeconds: 0 } });
        expect(collecting.collecting).toBe(true);
        expect(collecting.limits.windows).toEqual([]);
    });

    it('drops out-of-bounds pieces and never guesses', () => {
        expect(asRightNowPayload({ limits: { verdict: 'watch', windows: [{ label: 'Weekly', used: 178 }] } }).limits.windows).toEqual([]);
        expect(asRightNowPayload({ limits: { verdict: 'nonsense', windows: [] } }).limits.verdict).toBe('unknown');
        expect(asRightNowPayload({ limits: { verdict: 'go', windows: [{ used: 10 }] } }).limits.windows).toEqual([]);
        expect(asRightNowPayload('not an object').limits).toEqual({ verdict: 'unknown', windows: [] });
        expect(asRightNowPayload(null).vitals).toBeUndefined();
    });

    it('loses only the disk figure when the host could not stat a filesystem', () => {
        const vitals = asRightNowPayload({ vitals: { memoryUsed: 1, memoryTotal: 4, load1: 2, uptimeSeconds: 7_200 } }).vitals;
        expect(vitals).toBeDefined();
        expect(vitalsFacts(vitals!)).toEqual({ memoryPercent: 25, load: '2', uptime: '2h' });
        expect(asRightNowPayload({ vitals: { memoryUsed: 1, memoryTotal: 0, load1: 1, uptimeSeconds: 1 } }).vitals).toBeUndefined();
    });
});
