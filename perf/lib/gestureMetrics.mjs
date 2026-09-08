/**
 * Pure reductions for a measured gesture bout. No adb: the gate captures the
 * dumps and this module turns them into the numbers the limits judge.
 */
const NATIVE_PHASES = new Set(['herd tree fling', 'herd strip paging', 'document scroll']);
// One zoom phase per surface. A single phase had to discover which pane it had
// landed on and then judge itself by that, so whichever surface answered was
// the one it graded -- and a text pane standing in for the graphics fixture
// looked like a pass rather than the missing coverage it was.
export const ZOOM_PHASES = new Set(['text zoom tap', 'graphics zoom tap']);
const TERMINAL_PHASES = new Set(['terminal text fling', 'graphics pane scroll', ...ZOOM_PHASES]);
const SCROLL_PHASES = new Set([
    'herd tree fling',
    'herd strip paging',
    'document scroll',
    'terminal text fling',
    'graphics pane scroll',
]);

/** Same threshold the graphics-pane screenshot comparison uses. */
export const PIXEL_MOVE_THRESHOLD = 8 / 255;

function asNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function percentile(samples, p) {
    if (samples.length === 0) return 0;
    const ranked = samples.slice().sort((left, right) => left - right);
    const rank = Math.max(0, Math.ceil(p / 100 * ranked.length) - 1);
    return Math.round(ranked[rank] ?? 0);
}

function phaseName(phase) {
    return typeof phase === 'string' ? phase : phase?.name ?? '';
}

/** `/proc/uptime` first field, in seconds. */
export function parseUptime(text) {
    const first = String(text).trim().split(/\s+/)[0];
    const seconds = Number(first);
    return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Every `---PROFILEDATA---` CSV, keyed by the header row. Never by index:
 * Android inserts columns between releases.
 */
export function parseFrameStatsDump(text) {
    const rows = [];
    const blocks = String(text).split('---PROFILEDATA---');
    for (const block of blocks.slice(1)) {
        const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
        if (lines.length === 0) continue;
        if (lines[0].startsWith('---')) continue;
        const headers = lines[0].split(',').map((header) => header.trim());
        if (!headers.includes('Flags') || !headers.includes('FrameCompleted')) continue;
        for (const line of lines.slice(1)) {
            if (line.startsWith('---')) break;
            const cells = line.split(',');
            if (cells.length < headers.length) continue;
            const row = {};
            for (let index = 0; index < headers.length; index += 1) {
                const raw = (cells[index] ?? '').trim();
                const n = Number(raw);
                row[headers[index]] = raw !== '' && Number.isFinite(n) ? n : raw;
            }
            rows.push(row);
        }
    }
    return rows;
}

/**
 * The gfxinfo counters and histogram a `jankReport` would return, from a dump
 * already on disk. `hz` sets the one-frame budget; one frame is
 * `round(1000 / hz)` ms.
 */
export function parseJankDump(text, { hz = 60 } = {}) {
    const dump = String(text);
    const number = (pattern) => {
        const match = pattern.exec(dump);
        return match === null ? undefined : Number(match[1]);
    };
    const frames = number(/Total frames rendered:\s*(\d+)/);
    const janky = number(/Janky frames:\s*(\d+)/);
    const histogram = /HISTOGRAM:\s*(.+)/.exec(dump)?.[1] ?? '';
    const frameMs = Math.round(1000 / (Number(hz) > 0 ? Number(hz) : 60));
    let overOneFrame = 0;
    let overFourFrames = 0;
    for (const entry of histogram.split(' ')) {
        const [bucket, count] = entry.split('=');
        const ms = Number.parseInt(bucket ?? '', 10);
        const hits = Number.parseInt(count ?? '', 10);
        if (!Number.isFinite(ms) || !Number.isFinite(hits) || hits === 0) continue;
        if (ms > frameMs) overOneFrame += hits;
        if (ms > frameMs * 4) overFourFrames += hits;
    }
    // dumpsys writes 4950 ms into every percentile when the histogram is empty.
    // That is a sentinel, not a slow frame.
    const empty = frames === undefined || frames === 0;
    return {
        frames,
        janky,
        jankyPercent: empty || janky === undefined
            ? undefined
            : Math.round(janky / frames * 1000) / 10,
        p50Ms: empty ? undefined : number(/\n\s*50th percentile:\s*(\d+)ms/),
        p90Ms: empty ? undefined : number(/\n\s*90th percentile:\s*(\d+)ms/),
        p95Ms: empty ? undefined : number(/\n\s*95th percentile:\s*(\d+)ms/),
        p99Ms: empty ? undefined : number(/\n\s*99th percentile:\s*(\d+)ms/),
        missedVsync: number(/Number Missed Vsync:\s*(\d+)/),
        highInputLatency: number(/Number High input latency:\s*(\d+)/),
        deadlineMissed: number(/Number Frame deadline missed:\s*(\d+)/),
        overOneFrame,
        overFourFrames,
        histogram: histogram.trim(),
    };
}

/**
 * One fling's framestats ring. Dropped means Flags=0 and the frame missed two
 * vsyncs. Input-to-first-movement is the first input-driven frame after t0.
 */
export function reduceFrameStats(rows, { frameNs, t0Ns } = {}) {
    const budget = Number(frameNs) > 0 ? Number(frameNs) : 1e9 / 60;
    const origin = Number(t0Ns);
    const hasOrigin = Number.isFinite(origin);
    const good = [];
    for (const row of rows ?? []) {
        if (asNumber(row.Flags) !== 0) continue;
        const completed = asNumber(row.FrameCompleted);
        const intended = asNumber(row.IntendedVsync);
        if (completed === undefined || intended === undefined) continue;
        good.push({ ...row, FrameCompleted: completed, IntendedVsync: intended });
    }
    let dropped = 0;
    let worstNs = 0;
    const firstMovements = [];
    let sawFirst = false;
    for (const row of good) {
        const duration = row.FrameCompleted - row.IntendedVsync;
        if (duration > worstNs) worstNs = duration;
        if (duration > 2 * budget) dropped += 1;
        const inputId = asNumber(row.InputEventId) ?? 0;
        if (inputId === 0) continue;
        // Input-to-frame is measured from the moment the injector started. With
        // no such origin there is no latency to report: the frame's own
        // duration answers a different question and would pass this limit on it.
        if (!hasOrigin) continue;
        if (row.FrameCompleted < origin) continue;
        if (sawFirst) continue;
        sawFirst = true;
        firstMovements.push((row.FrameCompleted - origin) / 1e6);
    }
    const frames = good.length;
    return {
        frames,
        dropped,
        // No frames is no account of the bout, and no input-driven frame is no
        // account of the touch. Reporting either as a perfect zero passes a
        // limit on evidence that was never collected.
        droppedPercent: frames === 0 ? undefined : Math.round(dropped / frames * 1000) / 10,
        worstMs: Math.round(worstNs / 1e6),
        inputToFrameMs: firstMovements.length === 0 ? {} : {
            p50: percentile(firstMovements, 50),
            p95: percentile(firstMovements, 95),
        },
    };
}

/**
 * Rows of a rolling framestats ring that have not been counted yet. The ring
 * is re-read after every fling and mostly repeats what the last read already
 * held; summing those reads counts the same frame several times. `IntendedVsync`
 * is the frame's identity, so a read after a counter reset still adds once.
 */
export function freshFrameRows(rows, seen) {
    const fresh = [];
    for (const row of rows ?? []) {
        const key = asNumber(row.IntendedVsync);
        if (key === undefined || seen.has(key)) continue;
        seen.add(key);
        fresh.push(row);
    }
    return fresh;
}

/** Merge per-fling frameStats into one phase account. */
export function mergeFrameStats(parts) {
    let frames = 0;
    let dropped = 0;
    let worstMs = 0;
    const firsts = [];
    for (const part of parts ?? []) {
        frames += part.frames ?? 0;
        dropped += part.dropped ?? 0;
        if ((part.worstMs ?? 0) > worstMs) worstMs = part.worstMs;
        const first = part.inputToFrameMs?.p95 ?? part.inputToFrameMs?.p50;
        if (Number.isFinite(first) && first > 0) firsts.push(first);
    }
    return {
        frames,
        dropped,
        droppedPercent: frames === 0 ? undefined : Math.round(dropped / frames * 1000) / 10,
        worstMs,
        inputToFrameMs: firsts.length === 0 ? {} : {
            p50: percentile(firsts, 50),
            p95: percentile(firsts, 95),
        },
    };
}

function delta(after, before) {
    if (after === undefined || before === undefined) return after;
    return after - before;
}

/** Deltas of every jankReport field across a bout, plus the two percents. */
export function reduceJank(before, after, { hz } = {}) {
    void hz;
    const frames = delta(after?.frames, before?.frames);
    const janky = delta(after?.janky, before?.janky);
    const overOneFrame = delta(after?.overOneFrame, before?.overOneFrame) ?? 0;
    const overFourFrames = delta(after?.overFourFrames, before?.overFourFrames) ?? 0;
    const empty = frames === undefined || frames <= 0;
    const jankyPercent = empty || janky === undefined
        ? undefined
        : Math.round(janky / frames * 1000) / 10;
    return {
        frames: frames ?? 0,
        janky: janky ?? 0,
        jankyPercent,
        p50Ms: empty ? undefined : after?.p50Ms,
        p90Ms: empty ? undefined : after?.p90Ms,
        p95Ms: empty ? undefined : after?.p95Ms,
        p99Ms: empty ? undefined : after?.p99Ms,
        missedVsync: delta(after?.missedVsync, before?.missedVsync) ?? 0,
        highInputLatency: delta(after?.highInputLatency, before?.highInputLatency) ?? 0,
        deadlineMissed: delta(after?.deadlineMissed, before?.deadlineMissed) ?? 0,
        overOneFrame,
        overFourFrames,
        overOneFramePercent: frames === undefined || frames <= 0
            ? 0
            : Math.round(overOneFrame / frames * 1000) / 10,
        overFourFramesPercent: frames === undefined || frames <= 0
            ? 0
            : Math.round(overFourFrames / frames * 1000) / 10,
        histogram: after?.histogram ?? '',
    };
}

/**
 * Codes, counts, and durations only — the redacted diagnostics report.
 *
 * The phone's trail is a ring, so the counts a phase needs come from the
 * totals the report keeps apart from it, and every event carries the number it
 * was recorded at. `seq` is the phone's cursor at the moment of the pull.
 */
export function parseRedactedTrail(text) {
    const body = String(text);
    const firstFrames = [...body.matchAll(/terminal\.first-frame\s+(\d+)/g)].map((match) => Number(match[1]));
    const summary = /terminal\.scroll seq=(\d+) requests=(\d+) rows=(\d+) clamped=(\d+) timedOut=(\d+)/.exec(body);
    // Every line in the body is `<iso> #<seq> <summary>`, so an event a phase
    // did not cause can be told apart from one it did.
    const agentPages = [...body.matchAll(/#(\d+) (?:agent\.page\b|rpc session\.start\b)/g)].map((match) => Number(match[1]));
    // The cursor is the highest number the phone has handed out. A phone that
    // has recorded events but no gesture yet still has one, so a mark taken
    // before the first scroll is a usable mark rather than a missing one.
    const numbered = [...body.matchAll(/ #(\d+) /g)].map((match) => Number(match[1]));
    const seq = Math.max(summary === null ? 0 : Number(summary[1]), ...numbered, 0);
    return {
        seq: summary === null && numbered.length === 0 ? undefined : seq,
        scrollRequests: summary === null ? 0 : Number(summary[2]),
        rowsRequested: summary === null ? 0 : Number(summary[3]),
        clamped: summary === null ? 0 : Number(summary[4]),
        timedOut: summary === null ? 0 : Number(summary[5]),
        firstFrameMs: firstFrames.at(-1),
        agentPages,
    };
}

/**
 * What the phone recorded after a mark, and nothing else.
 *
 * The trail is a bounded ring: differencing what is still visible in it counts
 * a phase's own evictions as a quiet phone. Counts come from the totals, which
 * never evict, so a phase is judged on what the phone actually tallied rather
 * than on whatever the ring still happens to hold.
 */
export function trailSince(after, before) {
    if (after?.seq === undefined || before?.seq === undefined) return { ok: false, why: 'the phone reported no gesture totals' };
    // Totals only ever grow. Going backwards means the app restarted or the
    // trail was cleared under us, and nothing across that break is comparable.
    if (after.seq < before.seq
        || ['scrollRequests', 'rowsRequested', 'clamped', 'timedOut'].some((key) => (after[key] ?? 0) < (before[key] ?? 0))) {
        return { ok: false, why: 'the phone trail restarted during the phase' };
    }
    const since = (key) => (after[key] ?? 0) - (before[key] ?? 0);
    return {
        ok: true,
        seq: after.seq,
        scrollRequests: since('scrollRequests'),
        rowsRequested: since('rowsRequested'),
        clamped: since('clamped'),
        timedOut: since('timedOut'),
        agentPages: (after.agentPages ?? []).filter((seq) => seq > before.seq).length,
    };
}

/**
 * One JSONL body, parsed strictly, so a reader can tell an empty series apart
 * from one it failed to collect.
 *
 * A JSONL record is only complete on its newline, so anything after the last
 * one is a writer caught mid-append -- a partial record, not an absent one.
 * Folding that into "no records" is what lets a gate pass on evidence nobody
 * managed to read.
 */
export function parseJsonlStrict(text) {
    const body = String(text ?? '');
    if (body.length > 0 && !body.endsWith('\n')) {
        return { ok: false, why: 'truncated: the last record has no terminator' };
    }
    const rows = [];
    for (const line of body.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
            rows.push(JSON.parse(line));
        } catch {
            return { ok: false, why: 'a record could not be parsed' };
        }
    }
    return { ok: true, rows };
}

/**
 * Is `closing` the same append-only series `baseline` was, grown?
 *
 * An observation window is only one window if the file underneath it was
 * appended to and never rewritten. A closing read that lost records, or that
 * changed one the baseline already held, is a different file: the log rotated,
 * the harness re-entered the pane, or two panes wrote the same path. Slicing a
 * window out of that reads one pane's step off another's records, so it is
 * reported as unavailable rather than reduced.
 */
export function continuesFrom(baseline = [], closing = []) {
    if (closing.length < baseline.length) return { ok: false, why: 'the record series shrank between reads' };
    for (let index = 0; index < baseline.length; index += 1) {
        if (JSON.stringify(closing[index]) !== JSON.stringify(baseline[index])) {
            return { ok: false, why: `the record series was rewritten at ${index}` };
        }
    }
    return { ok: true, appended: closing.length - baseline.length };
}

/**
 * Grid transitions across one complete observation window.
 *
 * The window is every geometry record the pane declared, so it opens on the
 * grid the pane attached with -- a pane the phone never re-gridded still has a
 * baseline, and demanding a prior resize threw exactly that one away. A record
 * that repeats the grid before it is not a transition: a repaint, a re-attach
 * and a keyboard that came and went all re-declare the same grid, and counting
 * those made a still pane look like it had stepped. `shrank` is a transition to
 * strictly fewer columns *and* rows, the only shape a zoom in can take; a step
 * that grew the grid, held one dimension, or came back to where it started is
 * a further transition and fails on the count.
 */
export function reduceGridTransitions(records = []) {
    const transitions = [];
    let previous;
    for (const record of records) {
        const cols = Number(record?.cols);
        const rows = Number(record?.rows);
        if (!(cols > 0) || !(rows > 0)) continue;
        if (previous === undefined) {
            previous = { cols, rows };
            continue;
        }
        if (cols === previous.cols && rows === previous.rows) continue;
        transitions.push({
            from: previous,
            to: { cols, rows },
            shrank: cols < previous.cols && rows < previous.rows,
        });
        previous = { cols, rows };
    }
    return {
        transitions,
        count: transitions.length,
        shrankOnce: transitions.length === 1 && transitions[0].shrank === true,
    };
}

/**
 * Pipeline notches for one bout. `notchesDropped` is intent the cap ate —
 * the honest companion to `gestureDroppedPercent`, not a slow-frame count.
 */
export function reducePipelineNotches(events = []) {
    let notchesSent = 0;
    let notchesDropped = 0;
    let frames = 0;
    for (const event of events) {
        if (event?.event !== 'graphics.pipeline') continue;
        notchesSent += Number(event.notchesSent) || 0;
        notchesDropped += Number(event.notchesDropped) || 0;
        frames += Number(event.frames) || 0;
    }
    return { notchesSent, notchesDropped, frames };
}

function rawPixels(raw) {
    if (raw === undefined || raw === null) return Buffer.alloc(0);
    const bytes = Buffer.isBuffer(raw.bytes) ? raw.bytes : Buffer.isBuffer(raw) ? raw : Buffer.alloc(0);
    const width = Number(raw.width) || 0;
    const height = Number(raw.height) || 0;
    const pixels = width * height * 4;
    if (pixels > 0 && bytes.length === pixels + 16) return bytes.subarray(16);
    if (pixels > 0 && bytes.length === pixels + 12) return bytes.subarray(12);
    if (pixels > 0 && bytes.length >= pixels) return bytes.subarray(bytes.length - pixels);
    return bytes;
}

/** Crop a raw screencap (optional 12/16-byte header + RGBA8888) to `[l,t][r,b]`. */
export function cropRaw(raw, bounds = {}) {
    const width = Number(raw?.width) || 0;
    const height = Number(raw?.height) || 0;
    const src = rawPixels(raw);
    const left = Math.max(0, Math.min(width, Math.round(bounds.l ?? 0)));
    const top = Math.max(0, Math.min(height, Math.round(bounds.t ?? 0)));
    const right = Math.max(left, Math.min(width, Math.round(bounds.r ?? width)));
    const bottom = Math.max(top, Math.min(height, Math.round(bounds.b ?? height)));
    const cropW = right - left;
    const cropH = bottom - top;
    const out = Buffer.alloc(Math.max(0, cropW * cropH * 4));
    for (let y = 0; y < cropH; y += 1) {
        const srcOff = ((top + y) * width + left) * 4;
        src.copy(out, y * cropW * 4, srcOff, srcOff + cropW * 4);
    }
    return { width: cropW, height: cropH, bytes: out };
}

/** Mean |Δ| of RGB channels, as a fraction of 255. Same helper every surface uses. */
export function meanAbsDiff(before, after) {
    if (before === undefined || after === undefined) return 0;
    const left = rawPixels(before);
    const right = rawPixels(after);
    const width = Math.min(Number(before.width) || 0, Number(after.width) || 0);
    const height = Math.min(Number(before.height) || 0, Number(after.height) || 0);
    if (width <= 0 || height <= 0) return 0;
    let sum = 0;
    let count = 0;
    const aStride = (Number(before.width) || width) * 4;
    const bStride = (Number(after.width) || width) * 4;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const ai = y * aStride + x * 4;
            const bi = y * bStride + x * 4;
            sum += Math.abs((left[ai] ?? 0) - (right[bi] ?? 0));
            sum += Math.abs((left[ai + 1] ?? 0) - (right[bi + 1] ?? 0));
            sum += Math.abs((left[ai + 2] ?? 0) - (right[bi + 2] ?? 0));
            count += 3;
        }
    }
    return count === 0 ? 0 : sum / count / 255;
}

/**
 * The width of one block of the fixture's checkerboard, in screen pixels.
 *
 * Scanned across the middle rows of a crop: a colour step is a block edge, and
 * the median gap between edges is the block's size on screen. It survives the
 * load churning the pane, because the producer repaints the same board every
 * frame, and it is the only thing that changes when a local transform
 * magnifies a surface without touching the remote grid.
 */
export function checkerPeriod(crop, { minStep = 60, rows = 5 } = {}) {
    const width = Number(crop?.width) || 0;
    const height = Number(crop?.height) || 0;
    if (width < 8 || height < 8) return undefined;
    const pixels = rawPixels(crop);
    const gaps = [];
    for (let sample = 1; sample <= rows; sample += 1) {
        const y = Math.floor(height * sample / (rows + 1));
        let previousEdge;
        for (let x = 1; x < width; x += 1) {
            const left = (y * width + x - 1) * 4;
            const right = (y * width + x) * 4;
            const step = Math.abs((pixels[left] ?? 0) - (pixels[right] ?? 0))
                + Math.abs((pixels[left + 1] ?? 0) - (pixels[right + 1] ?? 0))
                + Math.abs((pixels[left + 2] ?? 0) - (pixels[right + 2] ?? 0));
            if (step < minStep) continue;
            if (previousEdge !== undefined && x - previousEdge > 1) gaps.push(x - previousEdge);
            previousEdge = x;
        }
    }
    if (gaps.length < 3) return undefined;
    gaps.sort((left, right) => left - right);
    return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Did the surface really magnify in place? One zoom step scales the pane by a
 * known factor, so its blocks must grow by that factor. A tap that changed
 * nothing, or a pane that reflowed instead of magnifying, does not.
 */
export function reduceMagnification(before, after, { expected, tolerance = 0.15 } = {}) {
    const beforePeriod = checkerPeriod(before);
    const afterPeriod = checkerPeriod(after);
    if (beforePeriod === undefined || afterPeriod === undefined) {
        return { proven: false, why: 'the surface has no measurable pattern to magnify', beforePeriod, afterPeriod };
    }
    const ratio = afterPeriod / beforePeriod;
    const want = Number(expected) > 0 ? Number(expected) : 1;
    return {
        proven: Math.abs(ratio - want) <= want * tolerance,
        beforePeriod,
        afterPeriod,
        ratio: Number(ratio.toFixed(3)),
        expected: want,
    };
}

export function pixelsMoved(before, after, { minMean = PIXEL_MOVE_THRESHOLD } = {}) {
    const meanAbs = meanAbsDiff(before, after);
    return { moved: meanAbs >= minMean, meanAbs, threshold: minMean };
}

// Decode UI-dump entities once: a literal "&amp;lt;" must stay "&lt;".
// Include the encoded newline emitted by Android's diagnostics Text view.
export function decodeUiAttribute(value) {
    const entities = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'", '&#10;': '\n' };
    return String(value ?? '').replace(/&(?:quot|amp|lt|gt|apos|#10);/g, (entity) => entities[entity]);
}

export function parseUiNodes(dump) {
    const nodes = [];
    for (const node of String(dump).match(/<node\b[^>]*>/g) ?? []) {
        const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
        if (bounds === null) continue;
        nodes.push({
            text: decodeUiAttribute(/text="([^"]*)"/.exec(node)?.[1]),
            desc: decodeUiAttribute(/content-desc="([^"]*)"/.exec(node)?.[1]),
            className: /class="([^"]*)"/.exec(node)?.[1] ?? '',
            l: Number(bounds[1]),
            t: Number(bounds[2]),
            r: Number(bounds[3]),
            b: Number(bounds[4]),
        });
    }
    return nodes;
}

/**
 * Is the fixture on the reading surface at all? Presence only: one node can
 * carry the whole document, so the first marker inside it is the first line of
 * the file wherever the viewport happens to be standing.
 */
export function firstDocumentMarker(dump) {
    const lines = [];
    for (const node of parseUiNodes(dump)) {
        const marker = /PERF_LINE_(\d+)/.exec(`${node.text ?? ''} ${node.desc ?? ''}`);
        if (marker !== null) lines.push({ ...node, marker: Number(marker[1]) });
    }
    lines.sort((left, right) => left.t - right.t || left.l - right.l);
    return lines[0]?.marker;
}

const MIN_GUTTER_ROWS = 4;

/** Individual gutter rows: one node, one line number, its own box. */
function gutterRows(nodes) {
    const rows = nodes
        .filter((node) => /^\d+$/.test((node.text ?? '').trim()) && node.b > node.t)
        .map((node) => ({ ...node, line: Number(node.text.trim()) }));
    const columns = new Map();
    for (const row of rows) columns.set(row.l, [...columns.get(row.l) ?? [], row]);
    const ranked = [...columns.values()].sort((left, right) => right.length - left.length);
    const column = ranked[0];
    if (column === undefined || column.length < MIN_GUTTER_ROWS) return [];
    // A tie between two columns of line numbers is not a gutter anyone can name.
    if (ranked[1] !== undefined && ranked[1].length === column.length) return [];
    return column.sort((left, right) => left.t - right.t);
}

/**
 * The scroller the document is actually read in, and the gutter rows visible
 * inside it. The reading surface nests scrollers, so the viewport is the
 * innermost vertical one holding the gutter -- never a screen percentage, which
 * crops chrome the phase never scrolled.
 */
export function documentViewport(dump) {
    const nodes = parseUiNodes(dump);
    const rows = gutterRows(nodes);
    if (rows.length === 0) return { why: 'the reading surface published no gutter rows' };
    const holding = nodes.filter((node) => /ScrollView|RecyclerView|ListView/i.test(node.className)
        && !/HorizontalScrollView/i.test(node.className)
        && node.b > node.t && node.r > node.l
        && rows.filter((row) => row.t >= node.t && row.b <= node.b && row.l >= node.l && row.r <= node.r).length >= 2);
    if (holding.length === 0) return { why: 'no vertical scroller holds the gutter' };
    const bounds = holding.reduce((best, next) => (area(next) < area(best) ? next : best));
    const visible = rows.filter((row) => (row.t + row.b) / 2 >= bounds.t && (row.t + row.b) / 2 <= bounds.b);
    if (visible.length === 0) return { why: 'no gutter row is inside the viewport' };
    return { bounds, visible };
}

function area(node) {
    return (node.r - node.l) * (node.b - node.t);
}

/** Vertical scrollers on screen, tallest first. */
export function verticalScrollers(dump) {
    return parseUiNodes(dump)
        .filter((node) => /ScrollView|RecyclerView|ListView/i.test(node.className)
            && !/HorizontalScrollView/i.test(node.className)
            && node.b - node.t > 0 && node.r - node.l > 0)
        .sort((left, right) => (right.b - right.t) - (left.b - left.t));
}

/**
 * Where the reading surface is standing: the topmost gutter row inside the
 * viewport and the offset it sits at. Offscreen rows are not a position, and
 * neither is a body node holding every line at once.
 */
export function documentPosition(dump) {
    const viewport = documentViewport(dump);
    if (viewport.visible === undefined) return undefined;
    const top = viewport.visible.reduce((best, next) => (next.t < best.t ? next : best));
    return { line: top.line, top: top.t };
}

function stripCards(dump) {
    const cards = parseUiNodes(dump).filter((node) => /Terminal/i.test(node.desc)
        || /\. (Idle|Working|Starting|Needs you|Done|Failed|Offline)\b/.test(node.desc ?? ''));
    cards.sort((left, right) => left.l - right.l || left.t - right.t);
    return cards;
}

/** Leftmost live-terminal card. */
export function firstStripCard(dump) {
    return stripCards(dump)[0];
}

/**
 * The card's identity line (`agentIdentityLine`), which the app joins last into
 * `agentAccessibilityLabel`. The task title and the state that precede it are
 * rewritten on a timer, so neither says which card is under the finger.
 */
export function stripCardIdentity(card) {
    const desc = card?.desc;
    if (desc === undefined || desc === '') return undefined;
    return desc.split('. ').pop();
}

/** Identity and position of the leftmost card: what paging has to change. */
export function stripPosition(dump) {
    const card = firstStripCard(dump);
    const identity = stripCardIdentity(card);
    if (identity === undefined) return undefined;
    return { identity, left: card.l };
}

/**
 * The horizontal scroller the live strip actually lives in. The herd screen
 * also carries a horizontal plugin-navigation scroller, so the strip is the one
 * whose box holds a live card -- never simply the first one in the dump.
 * Missing or ambiguous is reported, never guessed.
 */
export function stripScroller(dump) {
    const cards = stripCards(dump);
    if (cards.length === 0) return { why: 'no live terminal card is on screen' };
    const seen = new Map();
    for (const node of parseUiNodes(dump)) {
        if (!/HorizontalScrollView|ViewPager|RecyclerView/i.test(node.className)) continue;
        if (node.r <= node.l || node.b <= node.t) continue;
        if (!cards.some((card) => card.l >= node.l && card.r <= node.r && card.t >= node.t && card.b <= node.b)) continue;
        seen.set(`${node.l},${node.t},${node.r},${node.b}`, node);
    }
    const found = [...seen.values()];
    if (found.length === 0) return { why: 'no horizontal scroller holds a live terminal card' };
    if (found.length > 1) return { why: `${found.length} horizontal scrollers hold a live terminal card` };
    return { bounds: found[0] };
}

export function scrollableBounds(surface, dump, screen = {}) {
    const width = Number(screen.width) || 1080;
    const height = Number(screen.height) || 1920;
    const name = phaseName(surface);
    const nodes = parseUiNodes(dump);
    const ghostty = nodes.find((node) => /GhosttyTerminalView/i.test(node.className) || /GhosttyTerminalView/i.test(node.desc));
    if ((name === 'terminal' || name === 'terminal text fling'
        || name === 'graphics' || name === 'graphics pane scroll') && ghostty !== undefined) {
        return ghostty;
    }
    // The strip is cropped to the scroller it was measured on, or to nothing:
    // a fixed rectangle crops the plugin navigation above it just as happily.
    if (name === 'strip' || name === 'herd strip paging') {
        return stripScroller(dump).bounds;
    }
    if (name === 'tree' || name === 'herd tree fling') {
        return { l: Math.round(width * 0.08), t: Math.round(height * 0.42), r: width, b: height };
    }
    if (name === 'document' || name === 'document scroll') {
        return documentViewport(dump).bounds;
    }
    if (ghostty !== undefined) return ghostty;
    return { l: 0, t: Math.round(height * 0.2), r: width, b: Math.round(height * 0.9) };
}

/**
 * Did the content actually move? Pixels are required on every scroll surface.
 * Strip / document / terminal add the surface-specific proof on top.
 */
export function reduceMovement(phase, snapshot = {}) {
    const name = phaseName(phase);
    const pixels = snapshot.pixels ?? pixelsMoved(snapshot.before?.crop, snapshot.after?.crop);
    const reasons = [];
    const meanAbs = pixels?.meanAbs ?? 0;
    const threshold = pixels?.threshold ?? PIXEL_MOVE_THRESHOLD;
    const pixelOk = pixels?.moved === true;
    if (!pixelOk) reasons.push('pixels');

    if (name === 'herd strip paging' || name === 'strip') {
        const before = snapshot.before?.stripPosition;
        const after = snapshot.after?.stripPosition;
        if (before === undefined || after === undefined) {
            reasons.push('stripPosition');
            return { proven: false, meanAbs, threshold, reasons };
        }
        const paged = before.identity !== after.identity || before.left !== after.left;
        if (!paged) reasons.push('stripPosition');
        return { proven: pixelOk && paged, meanAbs, threshold, reasons, stripPosition: { before, after } };
    }
    if (name === 'document scroll' || name === 'document') {
        const before = snapshot.before?.documentPosition;
        const after = snapshot.after?.documentPosition;
        if (before === undefined || after === undefined) {
            reasons.push('documentPosition');
            return { proven: false, meanAbs, threshold, reasons };
        }
        const travelled = before.line !== after.line || before.top !== after.top;
        if (!travelled) reasons.push('documentPosition');
        return {
            proven: pixelOk && travelled,
            meanAbs,
            threshold,
            reasons,
            documentPosition: { before, after },
        };
    }
    if (name === 'terminal text fling' || name === 'terminal') {
        const terminal = snapshot.terminal ?? {};
        const scrollRows = terminal.rowsRequested ?? terminal.scrollRows ?? 0;
        const scrollRequests = terminal.scrollRequests ?? 0;
        const clamped = terminal.clamped ?? 0;
        // A still viewport is only honest evidence when the clamp is why it is
        // still. Reporting that as "content did not move" names the symptom and
        // hides the cause; the clamp is gated on its own, where it belongs.
        const atClampedEdge = clamped > 0;
        const asked = scrollRows > 0 && scrollRequests > 0;
        if (!asked) reasons.push('terminalTrail');
        if (clamped > 0) reasons.push('clamped');
        return {
            proven: (pixelOk || atClampedEdge) && asked,
            meanAbs,
            threshold,
            reasons,
            scrollRows,
            scrollRequests,
            clamped,
        };
    }
    return { proven: pixelOk, meanAbs, threshold, reasons };
}

function over(actual, limit) {
    return actual !== undefined && actual !== null && Number.isFinite(actual) && Number.isFinite(limit) && actual > limit;
}

function under(actual, limit) {
    return actual !== undefined && actual !== null && Number.isFinite(actual) && Number.isFinite(limit) && actual < limit;
}

function failWhen(failures, key, cond) {
    if (cond) failures.push(key);
}

/**
 * What a driven phase hands the verdict. It lives here, next to `verdict`, so
 * the metric a bout measured and the metric the gate grades cannot drift apart:
 * a field dropped on the way in reads exactly like a phase that never measured.
 */
export function phaseMetrics(driven, context = {}) {
    return {
        jank: driven.jank,
        frameStats: driven.frameStats,
        missedVsyncPerFling: driven.missedVsyncPerFling,
        frameCoverage: driven.frameCoverage,
        // One touch with no origin is one gesture nobody can time. Grading the
        // latency of the gestures that did report leaves the phase passing on a
        // population it chose after the fact.
        inputClockMissing: driven.gestureFrames?.some((window) => window.input === true
            && (window.clockUnavailable === true || !Number.isFinite(window.t0Seconds))),
        jsBusyDeltaPoints: context.jsBusyDeltaPoints,
        accidentalOwners: context.accidentalOwners,
        zoomTapped: driven.zoomTapped,
        zoomSurface: driven.zoomSurface,
        zoomMagnified: driven.zoomMagnified,
        zoomedOut: driven.zoomedOut,
        zoomReset: driven.zoomReset,
        zoomShrankOnce: driven.zoomShrankOnce,
        zoomAtRestDefault: driven.zoomAtRestDefault,
        zoomWindow: driven.zoomWindow,
        attachRecords: driven.attachRecords,
        surfaceKind: driven.surfaceKind ?? context.surfaceKind,
        terminal: driven.terminal,
        graphicsRowsPerSecond: driven.graphicsRowsPerSecond,
        zoomTransitions: driven.zoomTransitions,
        injectFailed: driven.injectFailed,
        movement: driven.movement,
    };
}

/**
 * Compare one phase's metrics to a LIMITS object. `failures` are LIMITS keys
 * (or the named document/inject predicates) so a test can assert the list.
 */
export function verdict(phase, metrics, limits) {
    const name = phaseName(phase);
    const failures = [];
    const jank = metrics?.jank ?? {};
    const frames = metrics?.frameStats ?? {};
    const terminal = metrics?.terminal ?? {};

    if (jank.frames === 0) failures.push('no frames in window');
    // A bout with no framestats ring, or one whose frames were never driven by
    // an input event, measured nothing. Both used to reduce to a perfect zero
    // and pass every limit below. A zoom tap is a touch like any other, so its
    // own tap-and-settle window is held to the same account.
    if (SCROLL_PHASES.has(name) || ZOOM_PHASES.has(name)) {
        if ((frames.frames ?? 0) === 0) failures.push('no framestats frames');
        else if (frames.inputToFrameMs?.p95 === undefined) failures.push('no input-driven frame');
    }
    failWhen(failures, 'gestureJankPercent', over(jank.jankyPercent, limits.gestureJankPercent));
    failWhen(failures, 'gestureP95Ms', over(jank.p95Ms, limits.gestureP95Ms));
    failWhen(failures, 'gestureP99Ms', over(jank.p99Ms, limits.gestureP99Ms));
    failWhen(failures, 'gestureOverFourFramesPercent', over(jank.overFourFramesPercent, limits.gestureOverFourFramesPercent));
    failWhen(failures, 'gestureDroppedPercent', over(frames.droppedPercent, limits.gestureDroppedPercent));
    // Per gesture means per gesture: the phase's accumulated count cannot say
    // which one missed. A zoom phase brackets its counters around the same tap
    // and settle its frames are cut to, and its broader jank stays a diagnostic.
    // No window at all is unavailable evidence, not a pass.
    if ((SCROLL_PHASES.has(name) || ZOOM_PHASES.has(name)) && (jank.frames ?? 0) > 0) {
        if (metrics.inputClockMissing === true) failures.push('a gesture reported no injector clock');
        if (metrics.missedVsyncPerFling === undefined) failures.push('no per-gesture vsync window');
        // The framestats ring is 120 frames deep. More frames drawn inside the
        // measured windows than were read back out of it means the ring wrapped
        // and this account is missing work.
        const coverage = metrics.frameCoverage;
        if (coverage === undefined) failures.push('no frame coverage account');
        else if (coverage.retained < coverage.rendered) failures.push('the framestats ring lost frames');
    }
    failWhen(failures, 'missedVsyncPerFling', over(metrics.missedVsyncPerFling, limits.missedVsyncPerFling));
    failWhen(failures, 'inputToFrameP95Ms', over(frames.inputToFrameMs?.p95, limits.inputToFrameP95Ms));

    if (NATIVE_PHASES.has(name)) {
        failWhen(failures, 'jsBusyDeltaNative', over(metrics.jsBusyDeltaPoints, limits.jsBusyDeltaNative));
    }
    if (TERMINAL_PHASES.has(name)) {
        failWhen(failures, 'jsBusyDeltaTerminal', over(metrics.jsBusyDeltaPoints, limits.jsBusyDeltaTerminal));
    }
    failWhen(failures, 'accidentalOwners', over(metrics.accidentalOwners, limits.accidentalOwners));

    if (name === 'terminal text fling') {
        // Terminal history has no answer frame that can be told apart from the
        // stream's own repaints, so there is no scroll-to-write latency to
        // judge. What is knowable is judged instead: that this was the text
        // surface, that the phone asked for rows and the clamp ate none, that
        // no scroll went unanswered, and that Android's own framestats show a
        // frame driven by the touch -- gated above for every scroll phase.
        failWhen(failures, 'the phase did not stand on a text terminal surface', metrics.surfaceKind !== 'text');
        failWhen(failures, 'the phone reported no scroll totals for this phase', terminal.scrollRequests === undefined);
        failWhen(failures, 'terminalRowsPerSecond', under(terminal.rowsPerSecond, limits.terminalRowsPerSecond));
        failWhen(failures, 'terminalScrollClamped', over(terminal.clamped, limits.terminalScrollClamped));
        failWhen(failures, 'a scroll timed out with no repaint', (terminal.timedOut ?? 0) > 0);
        failWhen(failures, 'accidentalOwners', over(terminal.agentPages, limits.accidentalOwners));
    }
    if (name === 'graphics pane scroll') {
        failWhen(failures, 'graphicsRowsPerSecond', under(terminal.rowsPerSecond ?? metrics.graphicsRowsPerSecond, limits.graphicsRowsPerSecond));
    }
    if (ZOOM_PHASES.has(name)) {
        // The pane has to have been this phase's own, taken over rather than
        // merely rendered, standing on the surface the phase claims to measure,
        // and untouched at its default before anything was tapped. A step read
        // off a pane that was already part-way up its ladder describes whatever
        // it was doing before the harness arrived.
        failWhen(failures, 'the zoom pane was not under control attach', !(metrics.attachRecords > 0));
        failWhen(failures, 'this phase measured the wrong zoom surface',
            metrics.zoomSurface !== metrics.surfaceKind);
        failWhen(failures, 'the zoom pane was not settled at its default before the tap',
            metrics.zoomAtRestDefault !== true);
        // Fail closed on the window itself. A geometry file that went missing,
        // could not be read, could not be parsed or was caught half-written is
        // an unavailable window, and the empty series it used to reduce to
        // passed a graphics pane by describing evidence nobody collected.
        failWhen(failures, 'the zoom observation window is unavailable', metrics.zoomWindow !== true);
        failWhen(failures, 'zoomTapped', metrics.zoomTapped !== true);
        // Which surface answered decides what the proof is. A text pane zooms by
        // re-gridding, which the host records; a graphics pane holds the remote
        // grid and magnifies its own surface, which only its pixels can show --
        // and those pixels, taken from this phase's own pane after the step, are
        // themselves the proof that a frame was delivered.
        if (metrics.zoomSurface === 'text') {
            failWhen(failures, 'zoomResizeCount', metrics.zoomTransitions !== limits.zoomResizeCount);
            failWhen(failures, 'the text zoom did not re-grid to fewer columns and rows',
                metrics.zoomShrankOnce !== true);
        } else if (metrics.zoomSurface === 'graphics') {
            failWhen(failures, 'zoomResizeCount', (metrics.zoomTransitions ?? 0) !== 0);
            failWhen(failures, 'zoom did not magnify the surface', metrics.zoomMagnified?.proven !== true);
        } else {
            failures.push('the zoom surface could not be identified');
        }
        failWhen(failures, 'zoom out did not return the surface', metrics.zoomedOut !== true);
        failWhen(failures, 'reset zoom did not return the surface', metrics.zoomReset !== true);
    }
    if (metrics.injectFailed === true) failures.push('device could not inject');
    if (SCROLL_PHASES.has(name) && metrics.movement !== undefined
        && metrics.injectFailed !== true && metrics.movement.proven !== true) {
        failures.push('content did not move');
    }

    return { pass: failures.length === 0, failures };
}
