import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hostSoakOutcome } from './hostSoakVerdict.mjs';

test('a loaded soak passes reconnects but not lost streams or children', () => {
    const report = { minutes: 15, terminalFrames: 1000, reconnectMs: [98, 105], hostRssDriftKb: 1024, unexpectedStreamEnds: 0 };
    const children = [{ exitCode: null, signal: null }, { exitCode: null, signal: null }];
    assert.equal(hostSoakOutcome(report, 150, children), 'pass');
    assert.equal(hostSoakOutcome({ ...report, unexpectedStreamEnds: 1 }, 150, children), 'failed');
    assert.equal(hostSoakOutcome(report, 150, [{ exitCode: 1, signal: null }, children[1]]), 'failed');
    assert.equal(hostSoakOutcome(report, 150, [{ exitCode: null, signal: 'SIGKILL' }, children[1]]), 'failed');
});
