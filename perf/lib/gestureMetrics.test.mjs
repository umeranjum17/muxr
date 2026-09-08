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
    parseJsonlStrict,
    continuesFrom,
    parseFrameStatsDump,
    parseJankDump,
    parseRedactedTrail,
    parseUptime,
    pixelsMoved,
    PIXEL_MOVE_THRESHOLD,
    reduceFrameStats,
    reduceJank,
    reduceMagnification,
    reduceMovement,
    reducePipelineNotches,
    reduceGridTransitions,
    trailSince,
    verdict,
} from './gestureMetrics.mjs';
import { herdChromeConnected, herdProof, worldLabels } from './pairPhone.mjs';

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
    // grew by since its own mark -- never the difference of what happens to
    // still be in the ring. There is no scroll-to-write latency here: terminal
    // history has no host answer a phone can attribute a repaint to.
    const mark = parseRedactedTrail('terminal.scroll seq=10 requests=1 rows=20 clamped=0 timedOut=0');
    const closing = parseRedactedTrail('2026-09-08T00:00:01Z #21 rpc session.start ok 5ms'
        + '\nterminal.scroll seq=30 requests=5 rows=100 clamped=0 timedOut=0');
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
    assert.equal(trail.timedOut, 0);
    assert.equal(trail.agentPages, 1);
    // Totals only ever grow; going backwards is a restart, not a quiet phase.
    assert.equal(trailSince(parseRedactedTrail(
        'terminal.scroll seq=2 requests=1 rows=4 clamped=0 timedOut=0',
    ), mark).ok, false);
    const terminalMoved = reduceMovement('terminal text fling', {
        before: { crop: still },
        after: { crop: shifted },
        terminal: trail,
    });
    assert.equal(terminalMoved.proven, true);
    // A viewport that did not change is still honest evidence when the clamp is
    // why it did not: that is reported as the clamp, not as content that never
    // moved. The clamp is gated on its own below.
    const clampedEdge = reduceMovement('terminal text fling', {
        before: { crop: still },
        after: { crop: still },
        terminal: { ...trail, clamped: 3 },
    });
    assert.equal(clampedEdge.proven, true);
    assert.ok(clampedEdge.reasons.includes('clamped'));
    // A phone that asked for nothing has no evidence at all.
    assert.equal(reduceMovement('terminal text fling', {
        before: { crop: still },
        after: { crop: shifted },
        terminal: { ...trail, rowsRequested: 0, scrollRequests: 0 },
    }).proven, false);

    // Rendering performance, not input latency: the text fling is judged on the
    // surface it stood on, what the phone asked the pane for, whether the clamp
    // ate any of it, whether a scroll went unanswered, and Android's own
    // gesture-scoped framestats -- never on a scroll-to-write duration.
    const flingJank = {
        jank: { frames: 10, jankyPercent: 1, p95Ms: 10, p99Ms: 12, overFourFramesPercent: 0, missedVsync: 0 },
        frameStats: { frames: 8, droppedPercent: 0, inputToFrameMs: { p95: 10 } },
    };
    const flingTerminal = { scrollRequests: 4, rowsRequested: 80, rowsPerSecond: 80, clamped: 0, timedOut: 0 };
    assert.deepEqual(verdict('terminal text fling', {
        ...flingJank, surfaceKind: 'text', terminal: flingTerminal,
    }, EMULATOR_LIMITS).failures, []);
    assert.deepEqual(verdict('terminal text fling', {
        ...flingJank, surfaceKind: 'graphics', terminal: flingTerminal,
    }, EMULATOR_LIMITS).failures, ['the phase did not stand on a text terminal surface']);
    assert.deepEqual(verdict('terminal text fling', {
        ...flingJank, surfaceKind: 'text', terminal: { ...flingTerminal, timedOut: 2 },
    }, EMULATOR_LIMITS).failures, ['a scroll timed out with no repaint']);
    assert.deepEqual(verdict('terminal text fling', {
        ...flingJank, surfaceKind: 'text', terminal: { ...flingTerminal, clamped: 1 },
    }, EMULATOR_LIMITS).failures, ['terminalScrollClamped']);
    assert.deepEqual(verdict('terminal text fling', {
        ...flingJank, surfaceKind: 'text', terminal: { scrollRequests: undefined },
    }, EMULATOR_LIMITS).failures, ['the phone reported no scroll totals for this phase']);
    // Framestats have to be the gesture's own; a bout the touch never drove
    // measured nothing and used to reduce to a perfect zero.
    assert.deepEqual(verdict('terminal text fling', {
        ...flingJank, frameStats: { frames: 8, droppedPercent: 0, inputToFrameMs: {} },
        surfaceKind: 'text', terminal: flingTerminal,
    }, EMULATOR_LIMITS).failures, ['no input-driven frame']);

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

    // The zoom window is only evidence if it was really collected. A JSONL
    // record is complete on its newline, so a body whose last line has no
    // terminator is a writer caught mid-append -- a partial record, not an
    // absent one, and folding it into "no records" is what lets a gate pass on
    // evidence nobody managed to read.
    const line = (cols) => `{"pane_id":"w1:p1","source":"terminal.resize","cols":${cols},"rows":24}\n`;
    assert.equal(parseJsonlStrict(line(80) + line(66)).rows.length, 2);
    assert.equal(parseJsonlStrict('').rows.length, 0);
    const truncated = parseJsonlStrict(line(80) + '{"pane_id":"w1:p1","cols":66');
    assert.equal(truncated.ok, false);
    assert.match(truncated.why, /truncated/);
    // A whole record that will not parse is unavailable too, never a short series.
    assert.equal(parseJsonlStrict(line(80) + 'not json\n').ok, false);

    // A window is one window only if the file underneath it was appended to and
    // never rewritten: a closing read that lost records, or changed one the
    // baseline already held, is a different file and cannot be sliced.
    const baseRows = [{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }];
    assert.equal(continuesFrom(baseRows, [...baseRows, { cols: 66, rows: 20 }]).ok, true);
    assert.equal(continuesFrom(baseRows, [...baseRows, { cols: 66, rows: 20 }]).appended, 1);
    assert.equal(continuesFrom(baseRows, baseRows).ok, true);
    assert.equal(continuesFrom(baseRows, [baseRows[0]]).ok, false);
    assert.match(continuesFrom(baseRows, [baseRows[0]]).why, /shrank/);
    const rewritten = continuesFrom(baseRows, [{ cols: 66, rows: 20 }, baseRows[1], { cols: 40, rows: 12 }]);
    assert.equal(rewritten.ok, false);
    assert.match(rewritten.why, /rewritten at 0/);

    // A zoom step is read off one complete window of the pane's own geometry.
    // The window may open on the grid the pane attached with -- a pane that
    // never re-gridded still declared one -- and a record that repeats the grid
    // before it is a repaint, a re-attach or a keyboard, not a step.
    const attachOnly = reduceGridTransitions([{ source: 'terminal.attach', cols: 80, rows: 24 }]);
    assert.equal(attachOnly.count, 0);
    const textStep = reduceGridTransitions([
        { source: 'terminal.attach', cols: 80, rows: 24 },
        { source: 'terminal.resize', cols: 80, rows: 24 },
        { source: 'terminal.resize', cols: 66, rows: 20 },
        { source: 'terminal.resize', cols: 66, rows: 20 },
    ]);
    assert.equal(textStep.count, 1);
    assert.equal(textStep.shrankOnce, true);
    // A grid change with no cell pixels is still a grid change; an emulator
    // that never declares a cell would otherwise report no step at all.
    assert.equal(reduceGridTransitions([{ cols: 80, rows: 24 }, { cols: 66, rows: 20 }]).shrankOnce, true);
    // A step that grew the grid, or held one dimension still, is not a zoom in.
    assert.equal(reduceGridTransitions([{ cols: 66, rows: 20 }, { cols: 80, rows: 24 }]).shrankOnce, false);
    assert.equal(reduceGridTransitions([{ cols: 80, rows: 24 }, { cols: 66, rows: 24 }]).shrankOnce, false);
    // A reversal inside the window is a second transition, so it never passes
    // as the one step the phase asked for.
    const reversal = reduceGridTransitions([
        { cols: 80, rows: 24 }, { cols: 66, rows: 20 }, { cols: 80, rows: 24 },
    ]);
    assert.equal(reversal.count, 2);
    assert.equal(reversal.shrankOnce, false);
    // A graphics pane holds its grid however many frames it draws.
    assert.equal(reduceGridTransitions([
        { cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16 },
        { cols: 80, rows: 24, cellWidthPx: 12, cellHeightPx: 24 },
    ]).count, 0);

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

    const zoomJank = {
        jank: { frames: 10, jankyPercent: 1, p95Ms: 10, p99Ms: 12, overFourFramesPercent: 0, missedVsync: 0 },
        // A zoom tap is a touch, so its own tap-and-settle window is held to
        // the same framestats account as any other gesture phase.
        frameStats: { frames: 6, droppedPercent: 0, inputToFrameMs: { p95: 10 } },
    };
    // The pane was this phase's own, taken over rather than merely rendered,
    // on the surface the phase claims, and untouched at its default before the
    // tap; the window it is then read from was collected without a gap.
    const stepped = {
        zoomTapped: true, zoomedOut: true, zoomReset: true,
        attachRecords: 1, zoomAtRestDefault: true, zoomWindow: true,
    };
    const text = {
        ...zoomJank, ...stepped, surfaceKind: 'text', zoomSurface: 'text',
        zoomTransitions: 1, zoomShrankOnce: true,
    };
    const graphics = {
        ...zoomJank, ...stepped, surfaceKind: 'graphics', zoomSurface: 'graphics',
        zoomTransitions: 0, zoomMagnified: { proven: true },
    };
    // Each surface has its own phase. A text pane re-grids exactly once, onto
    // fewer columns and rows; a graphics pane holds the remote grid and shows
    // the magnification in its own pixels -- which are themselves the proof a
    // frame was delivered, so no aggregate host count stands in for it.
    assert.deepEqual(verdict('text zoom tap', text, EMULATOR_LIMITS).failures, []);
    assert.deepEqual(verdict('graphics zoom tap', graphics, EMULATOR_LIMITS).failures, []);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, zoomTransitions: 2 }, EMULATOR_LIMITS).failures, ['zoomResizeCount']);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, zoomShrankOnce: false }, EMULATOR_LIMITS).failures,
        ['the text zoom did not re-grid to fewer columns and rows']);
    assert.deepEqual(verdict('graphics zoom tap',
        { ...graphics, zoomTransitions: 1 }, EMULATOR_LIMITS).failures, ['zoomResizeCount']);
    assert.deepEqual(verdict('graphics zoom tap',
        { ...graphics, zoomMagnified: { proven: false } }, EMULATOR_LIMITS).failures,
        ['zoom did not magnify the surface']);
    // A phase has to have stood on the surface it grades itself as. The
    // graphics fixture answering as a text pane is the miss a single
    // discover-then-grade phase used to report as a pass.
    assert.deepEqual(verdict('graphics zoom tap',
        { ...graphics, zoomSurface: 'text' }, EMULATOR_LIMITS).failures,
        ['this phase measured the wrong zoom surface', 'zoomResizeCount',
            'the text zoom did not re-grid to fewer columns and rows']);
    // Missing or interrupted evidence fails, never a silent zero: a pane never
    // under control attach, one not at its default, and a window whose JSONL
    // went missing, unreadable, unparsable or truncated all leave it unreadable.
    assert.deepEqual(verdict('text zoom tap',
        { ...text, attachRecords: 0 }, EMULATOR_LIMITS).failures,
        ['the zoom pane was not under control attach']);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, zoomAtRestDefault: false }, EMULATOR_LIMITS).failures,
        ['the zoom pane was not settled at its default before the tap']);
    assert.deepEqual(verdict('graphics zoom tap',
        { ...graphics, zoomWindow: undefined }, EMULATOR_LIMITS).failures,
        ['the zoom observation window is unavailable']);
    // The tap's own framestats are gated exactly as a fling's are.
    assert.deepEqual(verdict('text zoom tap',
        { ...text, frameStats: { frames: 0, inputToFrameMs: {} } }, EMULATOR_LIMITS).failures,
        ['no framestats frames']);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, frameStats: { frames: 6, droppedPercent: 0, inputToFrameMs: {} } }, EMULATOR_LIMITS).failures,
        ['no input-driven frame']);
    // Declared jank thresholds still apply to the zoom window.
    assert.deepEqual(verdict('text zoom tap',
        { ...text, jank: { ...zoomJank.jank, p95Ms: 400 } }, EMULATOR_LIMITS).failures, ['gestureP95Ms']);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, zoomTapped: false }, EMULATOR_LIMITS).failures, ['zoomTapped']);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, zoomSurface: undefined }, EMULATOR_LIMITS).failures,
        ['this phase measured the wrong zoom surface', 'the zoom surface could not be identified']);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, zoomedOut: false }, EMULATOR_LIMITS).failures,
        ['zoom out did not return the surface']);
    assert.deepEqual(verdict('text zoom tap',
        { ...text, zoomReset: false }, EMULATOR_LIMITS).failures,
        ['reset zoom did not return the surface']);

    const notches = reducePipelineNotches([
        { event: 'graphics.pipeline', frames: 5, notchesSent: 5, notchesDropped: 8 },
        { event: 'client.request', request: 'terminal.attach' },
        { event: 'graphics.pipeline', frames: 4, notchesSent: 4, notchesDropped: 0 },
    ]);
    assert.equal(notches.notchesSent, 9);
    assert.equal(notches.notchesDropped, 8);
    assert.equal(notches.frames, 9);
});

// The pairing proof, which is the one place chrome can pass for a herd: an app
// that never reached a host still paints LIVE, and a dropped connection still
// paints the herd it last fetched.
test('the herd is only proven by connected chrome and this run\'s own labels', () => {
    const world = { agents: [{ name: 'Pi 1' }], panes: [{ label: 'Pi 1' }, { label: 'zsh' }, { label: '' }] };
    assert.deepEqual(worldLabels(world), ['Pi 1', 'zsh']);
    const labels = worldLabels(world);
    const dump = (...nodes) => nodes.map((text) => `<node text="${text}" content-desc="" />`).join('');

    const paired = dump('LIVE', 'connected', 'pi · Pi 1 · 41');
    assert.equal(herdProof(paired, labels), undefined);
    assert.equal(herdChromeConnected(paired), true);

    // Generic chrome with no herd behind it.
    assert.match(herdProof(dump('LIVE', 'SPACES', 'Machine', 'connected'), labels), /no pane or agent/);
    // The herd is still painted, but the socket is gone.
    assert.match(herdProof(dump('LIVE', 'disconnected', 'pi · Pi 1 · 41'), labels), /not connected/);
    assert.match(herdProof(dump('LIVE', 'connecting', 'pi · Pi 1 · 41'), labels), /not connected/);
    assert.equal(herdChromeConnected(dump('LIVE', 'connected', 'Reconnecting…')), false);
    assert.equal(herdChromeConnected(dump('LIVE')), false);
});
