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
    firstDocumentMarker,
    firstStripLabel,
    freshFrameRows,
    mergeFrameStats,
    parseFrameStatsDump,
    parseJankDump,
    parseRedactedTrail,
    parseResizeTrail,
    parseUptime,
    pixelsMoved,
    PIXEL_MOVE_THRESHOLD,
    reduceFrameStats,
    reduceJank,
    reduceMagnification,
    reduceMovement,
    reducePipelineNotches,
    reduceZoom,
    resizesInInterval,
    trailSince,
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

    // The ring is re-read after every fling and mostly repeats itself; two
    // overlapping reads must still be one account of the same frames.
    const counted = new Set();
    const firstRead = reduceFrameStats(freshFrameRows(rows.slice(0, 4), counted), { frameNs, t0Ns });
    const secondRead = reduceFrameStats(freshFrameRows(rows, counted), { frameNs, t0Ns });
    assert.equal(mergeFrameStats([firstRead, secondRead]).frames, frames.frames);

    const still = { width: 4, height: 4, bytes: Buffer.alloc(4 * 4 * 4, 10) };
    const shifted = { width: 4, height: 4, bytes: Buffer.alloc(4 * 4 * 4, 40) };
    assert.equal(pixelsMoved(still, still).moved, false);
    const moved = pixelsMoved(still, shifted);
    assert.equal(moved.moved, true);
    assert.ok(moved.meanAbs >= PIXEL_MOVE_THRESHOLD);

    const dumpA = '<node text="PERF_LINE_0012 deterministic" class="android.widget.TextView" bounds="[8,200][900,220]" />'
        + '<node content-desc="Pi 1. Idle. Terminal" class="android.view.View" bounds="[16,120][300,320]" />';
    const dumpB = '<node text="PERF_LINE_0048 deterministic" class="android.widget.TextView" bounds="[8,200][900,220]" />'
        + '<node content-desc="Claude 1. Idle. Terminal" class="android.view.View" bounds="[16,120][300,320]" />';
    assert.equal(firstDocumentMarker(dumpA), 12);
    assert.equal(firstDocumentMarker(dumpB), 48);
    assert.equal(firstStripLabel(dumpA), 'Pi 1. Idle. Terminal');
    assert.notEqual(firstStripLabel(dumpA), firstStripLabel(dumpB));

    const documentMoved = reduceMovement('document scroll', {
        before: { crop: still, documentMarker: firstDocumentMarker(dumpA), stripLabel: firstStripLabel(dumpA) },
        after: { crop: shifted, documentMarker: firstDocumentMarker(dumpB), stripLabel: firstStripLabel(dumpB) },
    });
    assert.equal(documentMoved.proven, true);
    const stuck = reduceMovement('herd tree fling', {
        before: { crop: still },
        after: { crop: still },
    });
    assert.equal(stuck.proven, false);
    assert.deepEqual(verdict('herd tree fling', {
        jank: { frames: 10, jankyPercent: 1, p95Ms: 10, p99Ms: 12, overFourFramesPercent: 0, missedVsync: 0 },
        frameStats: { frames: 8, droppedPercent: 0, inputToFrameMs: { p95: 10 } },
        movement: stuck,
    }, EMULATOR_LIMITS).failures, ['content did not move']);

    // The phone's trail is a bounded ring, so a phase counts what the totals
    // grew by and the samples recorded after its own mark -- never the
    // difference of what happens to still be in the ring.
    const mark = parseRedactedTrail('terminal.scroll seq=10 requests=1 rows=20 clamped=0 latency p50=20ms p95=20ms'
        + '\nterminal.scroll-latency 9:20');
    const closing = parseRedactedTrail('2026-09-08T00:00:01Z #21 rpc session.start ok 5ms'
        + '\nterminal.scroll seq=30 requests=5 rows=100 clamped=0 latency p50=20ms p95=90ms'
        + '\nterminal.scroll-latency 9:20 22:30 26:40'
        + '\nterminal.resize count=2 8:80x24:cell=8x16 24:66x20:cell=10x20');
    const trail = trailSince(closing, mark);
    assert.equal(trail.ok, true);
    // A mark taken before the phone has scrolled at all still carries a cursor,
    // so the first measured phase is not reported as unavailable.
    const cold = parseRedactedTrail('2026-09-08T00:00:00Z #7 socket.state open live=true');
    assert.equal(cold.seq, 7);
    assert.equal(trailSince(closing, cold).ok, true);
    assert.equal(trailSince(closing, cold).scrollRequests, 5);
    assert.equal(trail.rowsRequested, 80);
    assert.equal(trail.scrollRequests, 4);
    assert.equal(trail.clamped, 0);
    // The sample the mark already saw is not this phase's, and the resize that
    // predates it is not this phase's zoom.
    assert.deepEqual(trail.scrollLatencies, [30, 40]);
    assert.equal(trail.scrollLatencyP95Ms, 40);
    assert.equal(trail.agentPages, 1);
    assert.equal(reduceZoom(trail.resizeEvents).gridChanged, 0);
    assert.equal(trail.resizeEvents.length, 1);
    // A phase that scrolled but kept no sample of its own is unavailable, not
    // a phone that answered in zero milliseconds.
    assert.equal(trailSince(parseRedactedTrail(
        'terminal.scroll seq=30 requests=5 rows=100 clamped=0 latency p50=20ms p95=90ms\nterminal.scroll-latency 9:20',
    ), mark).ok, false);
    assert.equal(trailSince(parseRedactedTrail(
        'terminal.scroll seq=2 requests=1 rows=4 clamped=0 latency p50=1ms p95=1ms\nterminal.scroll-latency 1:1',
    ), mark).ok, false);
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
        verdict('herd tree fling', { jank: empty, frameStats: { frames: 1, droppedPercent: 0, inputToFrameMs: { p95: 0 } } }, EMULATOR_LIMITS).failures,
        ['no frames in window'],
    );
    // A bout with no framestats ring, or none the touch drove, measured
    // nothing; it used to reduce to a perfect zero and pass every limit.
    const noRing = reduceFrameStats([], { frameNs, t0Ns });
    assert.equal(noRing.droppedPercent, undefined);
    assert.equal(noRing.inputToFrameMs.p95, undefined);
    assert.equal(mergeFrameStats([]).inputToFrameMs.p95, undefined);
    const goodJank = { frames: 10, jankyPercent: 1, p95Ms: 10, p99Ms: 12, overFourFramesPercent: 0, missedVsync: 0 };
    assert.deepEqual(
        verdict('herd tree fling', { jank: goodJank, frameStats: noRing }, EMULATOR_LIMITS).failures,
        ['no framestats frames'],
    );
    assert.deepEqual(
        verdict('herd tree fling', { jank: goodJank, frameStats: { frames: 4, droppedPercent: 0, inputToFrameMs: {} } }, EMULATOR_LIMITS).failures,
        ['no input-driven frame'],
    );

    const graphicsTrail = parseRedactedTrail(
        'terminal.resize count=3 1:80x24:cell=8x16 2:80x24:cell=12x24 3:80x24:cell=16x32',
    );
    assert.equal(graphicsTrail.resizeEvents.length, 3);
    const graphicsZoom = reduceZoom(graphicsTrail.resizeEvents);
    assert.equal(graphicsZoom.cellOnly, 2);
    assert.equal(graphicsZoom.gridChanged, 0);
    assert.equal(graphicsZoom.zoomResizeCount, 2);
    const textZoom = reduceZoom(parseResizeTrail('terminal.resize count=2 1:80x24:cell=8x16 2:66x20:cell=10x20'));
    assert.equal(textZoom.gridChanged, 1);
    assert.equal(textZoom.cellOnly, 0);

    // One zoom-in interval, read off the phone the way the host reads its own:
    // the last resize at or before the tap is the baseline, and only what the
    // phone timestamped inside the interval belongs to the step. The zoom out,
    // the second zoom in and the reset that follow are other steps entirely.
    const zoomTrail = parseResizeTrail('terminal.resize count=5'
        + ' 1:80x24:cell=8x16@1000 2:66x20:cell=10x20@2000'
        + ' 3:80x24:cell=8x16@3000 4:66x20:cell=10x20@4000 5:80x24:cell=8x16@5000');
    assert.equal(zoomTrail[1].at, 2000);
    // Reducing the whole phase counts every one of those steps.
    assert.equal(reduceZoom(zoomTrail).gridChanged, 4);
    const stepInterval = resizesInInterval(zoomTrail, { from: 1500, to: 2500 });
    assert.deepEqual(stepInterval.map((resize) => resize.seq), [1, 2]);
    assert.equal(reduceZoom(stepInterval).gridChanged, 1);
    // A phone that timestamped nothing has no account of the interval at all,
    // and neither has one whose first record is already past the baseline.
    assert.equal(resizesInInterval(parseResizeTrail('terminal.resize count=1 1:80x24:cell=8x16'), { from: 1500, to: 2500 }), undefined);
    assert.equal(resizesInInterval(zoomTrail, { from: 500, to: 1500 }), undefined);

    // A checkerboard magnified by one graphics step: the same board, its blocks
    // 1.25x wider. A tap that magnified nothing leaves them exactly as they were.
    const board = (blockPx) => {
        const width = 120;
        const height = 16;
        const bytes = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
            const dark = Math.floor(x / blockPx) % 2 === 0;
            bytes.set(dark ? [235, 35, 170, 255] : [20, 215, 185, 255], (y * width + x) * 4);
        }
        return { width, height, bytes };
    };
    assert.equal(reduceMagnification(board(8), board(10), { expected: 1.25 }).proven, true);
    assert.equal(reduceMagnification(board(8), board(8), { expected: 1.25 }).proven, false);
    const flat = { width: 120, height: 16, bytes: Buffer.alloc(120 * 16 * 4, 30) };
    assert.equal(reduceMagnification(flat, flat, { expected: 1.25 }).proven, false);

    const zoomJank = { jank: { frames: 10, jankyPercent: 1, p95Ms: 10, p99Ms: 12, overFourFramesPercent: 0, missedVsync: 0 }, frameStats: { droppedPercent: 0, inputToFrameMs: { p95: 10 } } };
    const stepped = { zoomTapped: true, zoomedOut: true, zoomReset: true, zoomPhoneResizeCount: 1, zoomPhoneEvidence: true };
    // A text pane re-grids exactly once per step; a graphics pane holds the
    // remote grid and has to show the magnification in its own pixels. A tap
    // the app never acted on passes neither.
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomSurface: 'text', zoomResizeCount: 1,
    }, EMULATOR_LIMITS).failures, []);
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomSurface: 'text', zoomResizeCount: 2,
    }, EMULATOR_LIMITS).failures, ['zoomResizeCount']);
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomSurface: 'graphics', zoomResizeCount: 0,
        zoomPhoneResizeCount: 0, zoomMagnified: { proven: true },
    }, EMULATOR_LIMITS).failures, []);
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomSurface: 'graphics', zoomResizeCount: 0,
        zoomPhoneResizeCount: 0, zoomMagnified: { proven: false },
    }, EMULATOR_LIMITS).failures, ['zoom did not magnify the surface']);
    // The host and the phone have to describe the same step. One source alone
    // cannot tell a real zoom from a repaint that happened to re-grid.
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomSurface: 'text', zoomResizeCount: 1, zoomPhoneResizeCount: 0,
    }, EMULATOR_LIMITS).failures, ['the phone trail does not match the host zoom re-grid']);
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomSurface: 'graphics', zoomResizeCount: 0,
        zoomPhoneResizeCount: 1, zoomMagnified: { proven: true },
    }, EMULATOR_LIMITS).failures, ['the phone trail re-gridded a graphics zoom']);
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomTapped: false, zoomSurface: 'text', zoomResizeCount: 1,
    }, EMULATOR_LIMITS).failures, ['zoomTapped']);
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomResizeCount: 1,
    }, EMULATOR_LIMITS).failures, ['the zoom surface could not be identified']);
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomedOut: false, zoomSurface: 'text', zoomResizeCount: 1,
    }, EMULATOR_LIMITS).failures, ['zoom out did not return the surface']);
    // Without the phone's own account of the interval there is nothing to
    // corroborate the host with, and a silent zero must not read as agreement.
    assert.deepEqual(verdict('zoom tap navigate', {
        ...zoomJank, ...stepped, zoomPhoneEvidence: false, zoomSurface: 'graphics',
        zoomResizeCount: 0, zoomPhoneResizeCount: 0, zoomMagnified: { proven: true },
    }, EMULATOR_LIMITS).failures, ['the phone kept no resize evidence for this zoom step']);

    const notches = reducePipelineNotches([
        { event: 'graphics.pipeline', frames: 5, notchesSent: 5, notchesDropped: 8 },
        { event: 'client.request', request: 'terminal.attach' },
        { event: 'graphics.pipeline', frames: 4, notchesSent: 4, notchesDropped: 0 },
    ]);
    assert.equal(notches.notchesSent, 9);
    assert.equal(notches.notchesDropped, 8);
    assert.equal(notches.frames, 9);
});
