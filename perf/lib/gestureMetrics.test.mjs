/**
 * One flow test for the gesture reducers. Fixtures are a real emulator dump
 * (header, histogram, PROFILEDATA columns) filled with the baseline bout this
 * machine already measured: 26.3% janky, p95 150 ms.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
    firstGutterLine,
    firstStripLabel,
    parseFrameStatsDump,
    parseJankDump,
    parseRedactedTrail,
    parseResizeTrail,
    parseUptime,
    pixelsMoved,
    PIXEL_MOVE_THRESHOLD,
    reduceFrameStats,
    reduceJank,
    reduceMovement,
    reducePipelineNotches,
    reduceZoom,
    verdict,
} from './gestureMetrics.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const read = (name) => readFileSync(join(fixtures, name), 'utf8');

const EMULATOR_LIMITS = {
    gestureJankPercent: 20,
    gestureP95Ms: 100,
    gestureP99Ms: 250,
    gestureOverFourFramesPercent: 3,
    gestureDroppedPercent: 12,
    missedVsyncPerFling: 3,
    inputToFrameP95Ms: 120,
    jsBusyDeltaNative: 15,
    jsBusyDeltaTerminal: 25,
    accidentalOwners: 0,
    terminalScrollP95Ms: 250,
    terminalRowsPerSecond: 40,
    terminalScrollClamped: 0,
    graphicsRowsPerSecond: 9,
    zoomResizeCount: 1,
};

test('baseline bout fixtures reduce to the documented failures', () => {
    const hz = 60;
    const frameNs = 1e9 / hz;
    const t0Ns = parseUptime(read('uptime.txt')) * 1e9;
    const rows = parseFrameStatsDump(read('framestats.txt'));
    const frames = reduceFrameStats(rows, { frameNs, t0Ns });
    const jank = reduceJank(
        parseJankDump(read('gfxinfo-before.txt'), { hz }),
        parseJankDump(read('gfxinfo-after.txt'), { hz }),
        { hz },
    );
    const judged = verdict('herd tree fling', { jank, frameStats: frames }, EMULATOR_LIMITS);

    assert.equal(jank.jankyPercent, 26.3);
    assert.equal(jank.p95Ms, 150);
    assert.deepEqual(judged.failures, ['gestureJankPercent', 'gestureP95Ms']);
    assert.equal(judged.pass, false);

    const late = rows.map((row, index) => {
        if (index >= 3) return row;
        return { ...row, FrameCompleted: row.IntendedVsync + 3 * frameNs + 1 };
    });
    const doctored = reduceFrameStats(late, { frameNs, t0Ns });
    assert.equal(doctored.dropped, 3);

    const still = { width: 4, height: 4, bytes: Buffer.alloc(4 * 4 * 4, 10) };
    const shifted = { width: 4, height: 4, bytes: Buffer.alloc(4 * 4 * 4, 40) };
    assert.equal(pixelsMoved(still, still).moved, false);
    const moved = pixelsMoved(still, shifted);
    assert.equal(moved.moved, true);
    assert.ok(moved.meanAbs >= PIXEL_MOVE_THRESHOLD);

    const dumpA = '<node text="12" class="android.widget.TextView" bounds="[8,200][40,220]" />'
        + '<node content-desc="Pi 1. Idle. Terminal" class="android.view.View" bounds="[16,120][300,320]" />';
    const dumpB = '<node text="48" class="android.widget.TextView" bounds="[8,200][40,220]" />'
        + '<node content-desc="Claude 1. Idle. Terminal" class="android.view.View" bounds="[16,120][300,320]" />';
    assert.equal(firstGutterLine(dumpA), 12);
    assert.equal(firstGutterLine(dumpB), 48);
    assert.equal(firstStripLabel(dumpA), 'Pi 1. Idle. Terminal');
    assert.notEqual(firstStripLabel(dumpA), firstStripLabel(dumpB));

    const documentMoved = reduceMovement('document scroll and swipe', {
        before: { crop: still, gutterLine: 12, stripLabel: firstStripLabel(dumpA) },
        after: { crop: shifted, gutterLine: 48, stripLabel: firstStripLabel(dumpB) },
    });
    assert.equal(documentMoved.proven, true);
    const stuck = reduceMovement('herd tree fling', {
        before: { crop: still },
        after: { crop: still },
    });
    assert.equal(stuck.proven, false);
    assert.deepEqual(verdict('herd tree fling', {
        jank: { jankyPercent: 1, p95Ms: 10, p99Ms: 12, overFourFramesPercent: 0, missedVsync: 0 },
        frameStats: { droppedPercent: 0, inputToFrameMs: { p95: 10 } },
        movement: stuck,
    }, EMULATOR_LIMITS).failures, ['content did not move']);

    const trail = parseRedactedTrail('terminal.scroll requests=4 rows=80 clamped=0 latency p50=20ms p95=40ms');
    assert.equal(trail.rowsRequested, 80);
    assert.equal(trail.clamped, 0);
    assert.equal(trail.scrollRequests, 4);
    const terminalMoved = reduceMovement('terminal text fling', {
        before: { crop: still },
        after: { crop: shifted },
        terminal: trail,
    });
    assert.equal(terminalMoved.proven, true);

    const emptyDump = parseJankDump(read('gfxinfo-before.txt'), { hz });
    assert.equal(emptyDump.frames, 0);
    assert.equal(emptyDump.p95Ms, undefined);
    const empty = reduceJank(emptyDump, emptyDump, { hz });
    assert.equal(empty.frames, 0);
    assert.equal(empty.p95Ms, undefined);
    assert.deepEqual(
        verdict('herd tree fling', { jank: empty, frameStats: { droppedPercent: 0, inputToFrameMs: { p95: 0 } } }, EMULATOR_LIMITS).failures,
        ['no frames in window'],
    );

    const graphicsTrail = parseRedactedTrail(
        'terminal.resize 80x24 cell=8x16\nterminal.resize 80x24 cell=12x24\nterminal.resize 80x24 cell=16x32',
    );
    assert.equal(graphicsTrail.resizes, 3);
    const graphicsZoom = reduceZoom(graphicsTrail.resizeEvents);
    assert.equal(graphicsZoom.cellOnly, 2);
    assert.equal(graphicsZoom.gridChanged, 0);
    assert.equal(graphicsZoom.zoomResizeCount, 2);
    const oneStep = reduceZoom(parseResizeTrail('terminal.resize 80x24 cell=8x16\nterminal.resize 80x24 cell=12x24'));
    assert.equal(oneStep.cellOnly, 1);
    assert.deepEqual(
        verdict('zoom tap navigate', { jank: { frames: 10, jankyPercent: 1, p95Ms: 10, p99Ms: 12, overFourFramesPercent: 0, missedVsync: 0 }, frameStats: { droppedPercent: 0, inputToFrameMs: { p95: 10 } }, zoomResizeCount: oneStep.cellOnly }, EMULATOR_LIMITS).failures,
        [],
    );
    const textZoom = reduceZoom(parseResizeTrail('terminal.resize 80x24 cell=8x16\nterminal.resize 66x20 cell=10x20'));
    assert.equal(textZoom.gridChanged, 1);
    assert.equal(textZoom.cellOnly, 0);

    const notches = reducePipelineNotches([
        { event: 'graphics.pipeline', frames: 5, notchesSent: 5, notchesDropped: 8 },
        { event: 'client.request', request: 'terminal.attach' },
        { event: 'graphics.pipeline', frames: 4, notchesSent: 4, notchesDropped: 0 },
    ]);
    assert.equal(notches.notchesSent, 9);
    assert.equal(notches.notchesDropped, 8);
    assert.equal(notches.frames, 9);
});
