import { beforeEach, describe, expect, it } from 'vitest';
import {
    formatConnectionDiagnosticsForReport,
    recordTerminalPanRows,
    recordTerminalScrollRows,
    resetConnectionDiagnostics,
} from './connectionDiagnostics';

describe('a terminal fling in the redacted report', () => {
    beforeEach(() => resetConnectionDiagnostics());

    it('counts rows the grid absorbed apart from rows sent to Herdr', () => {
        // A fling the grid's own pan absorbs entirely: no request leaves the phone.
        recordTerminalPanRows(40);
        expect(formatConnectionDiagnosticsForReport()).toMatch(/terminal\.scroll seq=\d+ requests=0 rows=0 clamped=0 timedOut=0 absorbed=40$/m);

        // A later scroll that did reach Herdr adds its request and its rows, and nothing else.
        recordTerminalScrollRows(5);
        expect(formatConnectionDiagnosticsForReport()).toMatch(/terminal\.scroll seq=\d+ requests=1 rows=5 clamped=0 timedOut=0 absorbed=40$/m);
    });
});
