import { describe, expect, it } from 'vitest';
import { asRightNowPayload, vitalsFacts } from './rightNowModel';

/** The card's contract end to end: the host's typed payload survives the
 *  bounded parser with its figures, and junk degrades to the quiet state
 *  instead of crashing Home. */
describe('right now payload', () => {
    it('keeps the host payload the card renders', () => {
        const payload = asRightNowPayload({
            limit: { verdict: 'watch', label: 'Weekly limit', used: 78, resetsIn: '4d 17h', elapsed: 0.61 },
            vitals: {
                memoryUsed: 56_375_000_000, memoryTotal: 98_784_000_000,
                diskUsed: 431_600_000_000, diskTotal: 998_000_000_000,
                load1: 5.27, uptimeSeconds: 425_000,
            },
        });
        expect(payload.limit).toEqual({ verdict: 'watch', label: 'Weekly limit', used: 78, resetsIn: '4d 17h', elapsed: 0.61 });
        expect(payload.collecting).toBeUndefined();
        expect(vitalsFacts(payload.vitals!)).toEqual({ memoryPercent: 57, diskPercent: 43, load: '5.3', uptime: '4d' });
    });

    it('reads the collecting fallback', () => {
        const collecting = asRightNowPayload({ collecting: true, vitals: { memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2, load1: 0, uptimeSeconds: 0 } });
        expect(collecting.collecting).toBe(true);
        expect(collecting.limit).toBeUndefined();
    });

    it('drops out-of-bounds pieces and never guesses', () => {
        expect(asRightNowPayload({ limit: { verdict: 'watch', label: 'Weekly', used: 178 } })).toEqual({});
        expect(asRightNowPayload({ limit: { verdict: 'nonsense', label: 'Weekly', used: 10 } }).limit?.verdict).toBe('unknown');
        expect(asRightNowPayload({ limit: { verdict: 'go', used: 10 } })).toEqual({});
        expect(asRightNowPayload({ vitals: { memoryUsed: 1, memoryTotal: 0, diskUsed: 0, diskTotal: 1, load1: 1, uptimeSeconds: 1 } }).vitals).toBeUndefined();
        expect(asRightNowPayload('not an object')).toEqual({});
        expect(asRightNowPayload(null)).toEqual({});
    });
});
