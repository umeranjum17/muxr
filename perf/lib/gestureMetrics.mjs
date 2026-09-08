/**
 * Pure reductions for a measured gesture bout. No adb: the gate captures the
 * dumps and this module turns them into the numbers the limits judge.
 */
const NATIVE_PHASES = new Set(['herd tree fling', 'herd strip paging', 'document scroll']);
const TERMINAL_PHASES = new Set(['terminal text fling', 'graphics pane scroll', 'zoom tap navigate']);
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
        if (hasOrigin && row.FrameCompleted < origin) continue;
        if (sawFirst) continue;
        sawFirst = true;
        firstMovements.push(hasOrigin ? (row.FrameCompleted - origin) / 1e6 : duration / 1e6);
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
    const summary = /terminal\.scroll seq=(\d+) requests=(\d+) rows=(\d+) clamped=(\d+) latency p50=(\d+)ms p95=(\d+)ms/.exec(body);
    const samples = [];
    for (const match of body.matchAll(/terminal\.scroll-latency ((?:\d+:\d+ ?)+)/g)) {
        for (const pair of match[1].trim().split(/\s+/)) {
            const [seq, ms] = pair.split(':').map(Number);
            if (Number.isFinite(seq) && Number.isFinite(ms)) samples.push({ seq, ms });
        }
    }
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
        scrollLatencyP50Ms: summary === null ? 0 : Number(summary[5]),
        scrollLatencyP95Ms: summary === null ? 0 : Number(summary[6]),
        scrollLatencies: samples,
        firstFrameMs: firstFrames.at(-1),
        resizeEvents: parseResizeTrail(body),
        agentPages,
    };
}

/**
 * What the phone recorded after a mark, and nothing else.
 *
 * The trail is a bounded ring: differencing what is still visible in it counts
 * a phase's own evictions as a quiet phone. Counts come from the totals, which
 * never evict, and percentiles come from the samples recorded after the mark —
 * so a phase that asked for scrolls the phone has no samples for is reported
 * unavailable instead of as a perfect zero.
 */
export function trailSince(after, before) {
    if (after?.seq === undefined || before?.seq === undefined) return { ok: false, why: 'the phone reported no gesture totals' };
    // Totals only ever grow. Going backwards means the app restarted or the
    // trail was cleared under us, and nothing across that break is comparable.
    if (after.seq < before.seq
        || ['scrollRequests', 'rowsRequested', 'clamped'].some((key) => (after[key] ?? 0) < (before[key] ?? 0))) {
        return { ok: false, why: 'the phone trail restarted during the phase' };
    }
    const since = (key) => (after[key] ?? 0) - (before[key] ?? 0);
    const scrollRequests = since('scrollRequests');
    const latencies = (after.scrollLatencies ?? []).filter((sample) => sample.seq > before.seq).map((sample) => sample.ms);
    if (scrollRequests > 0 && latencies.length === 0) {
        return { ok: false, why: 'the phone kept no scroll latency sample from this phase' };
    }
    return {
        ok: true,
        seq: after.seq,
        scrollRequests,
        rowsRequested: since('rowsRequested'),
        clamped: since('clamped'),
        scrollLatencies: latencies,
        scrollLatencyP50Ms: percentile(latencies, 50),
        scrollLatencyP95Ms: percentile(latencies, 95),
        resizeEvents: (after.resizeEvents ?? []).filter((resize) => resize.seq > before.seq),
        agentPages: (after.agentPages ?? []).filter((seq) => seq > before.seq).length,
    };
}

/**
 * `terminal.resize count=3 12:80x24:cell=8x16 …` — the phone's own resize line,
 * kept out of the ring so a zoom step cannot be evicted by a frame. Grid
 * always, cell when the phone sent it. An image-pane zoom is a cell change
 * with the grid held still; a text-pane zoom is the reverse.
 */
export function parseResizeTrail(text) {
    const resizes = [];
    const line = /terminal\.resize count=\d+ (.*)/.exec(String(text));
    if (line === null) return resizes;
    for (const match of line[1].matchAll(/(\d+):(\d+)x(\d+)(?::cell=(\d+)x(\d+))?/g)) {
        resizes.push({
            seq: Number(match[1]),
            cols: Number(match[2]),
            rows: Number(match[3]),
            ...(match[4] === undefined ? {} : { cellWidthPx: Number(match[4]) }),
            ...(match[5] === undefined ? {} : { cellHeightPx: Number(match[5]) }),
        });
    }
    return resizes;
}

/**
 * Consecutive resize events. `cellOnly` is a graphics k-step; `gridChanged`
 * is a text font-ladder step. Either one is a countable zoom.
 */
export function reduceZoom(resizes = []) {
    let cellOnly = 0;
    let gridChanged = 0;
    for (let index = 1; index < resizes.length; index += 1) {
        const previous = resizes[index - 1];
        const next = resizes[index];
        const grid = previous.cols !== next.cols || previous.rows !== next.rows;
        const cell = previous.cellWidthPx !== undefined && next.cellWidthPx !== undefined
            && (previous.cellWidthPx !== next.cellWidthPx || previous.cellHeightPx !== next.cellHeightPx);
        if (grid) gridChanged += 1;
        else if (cell) cellOnly += 1;
    }
    return {
        cellOnly,
        gridChanged,
        zoomResizeCount: cellOnly + gridChanged,
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
 * Topmost fixture line on the reading surface. The surface is gutter-less, so
 * the document's own numbered text is the only thing that says where it is.
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

/** Leftmost live-terminal card. Its label is the visible index we can observe. */
export function firstStripCard(dump) {
    const cards = parseUiNodes(dump).filter((node) => /Terminal/i.test(node.desc)
        || /\. (Idle|Working|Starting|Needs you|Done|Failed|Offline)\b/.test(node.desc ?? ''));
    cards.sort((left, right) => left.l - right.l || left.t - right.t);
    return cards[0];
}

export function firstStripLabel(dump) {
    return firstStripCard(dump)?.desc;
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
    if (name === 'strip' || name === 'herd strip paging') {
        return { l: 0, t: Math.round(height * 0.18), r: width, b: Math.round(height * 0.48) };
    }
    if (name === 'tree' || name === 'herd tree fling') {
        return { l: Math.round(width * 0.08), t: Math.round(height * 0.42), r: width, b: height };
    }
    if (name === 'document' || name === 'document scroll') {
        return { l: 0, t: Math.round(height * 0.18), r: width, b: height };
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
        const before = snapshot.before?.stripLabel;
        const after = snapshot.after?.stripLabel;
        if (before !== undefined && after !== undefined) {
            if (before === after) reasons.push('stripLabel');
            return {
                proven: pixelOk && before !== after,
                meanAbs,
                threshold,
                reasons,
                stripLabel: { before, after },
            };
        }
        return { proven: pixelOk, meanAbs, threshold, reasons };
    }
    if (name === 'document scroll' || name === 'document') {
        const before = snapshot.before?.documentMarker;
        const after = snapshot.after?.documentMarker;
        const textMoved = before !== undefined && after !== undefined && before !== after;
        if (!textMoved) reasons.push('documentMarker');
        return {
            proven: pixelOk && textMoved,
            meanAbs,
            threshold,
            reasons,
            documentMarker: { before, after },
        };
    }
    if (name === 'terminal text fling' || name === 'terminal') {
        const terminal = snapshot.terminal ?? {};
        const scrollRows = terminal.rowsRequested
            ?? terminal.scrollRows
            ?? 0;
        const scrollLatencyEvents = terminal.scrollRequests
            || (Array.isArray(terminal.scrollLatencies) ? terminal.scrollLatencies.length : 0)
            || 0;
        const clamped = terminal.clamped ?? 0;
        if (!(scrollRows > 0) || !(scrollLatencyEvents > 0)) reasons.push('terminalTrail');
        if (clamped > 0) reasons.push('clamped');
        return {
            proven: pixelOk && scrollRows > 0 && scrollLatencyEvents > 0 && clamped === 0,
            meanAbs,
            threshold,
            reasons,
            scrollRows,
            scrollLatencyEvents,
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
    if (SCROLL_PHASES.has(name)) {
        // A bout with no framestats ring, or one whose frames were never driven
        // by an input event, measured nothing. Both used to reduce to a perfect
        // zero and pass every limit below.
        if ((frames.frames ?? 0) === 0) failures.push('no framestats frames');
        else if (frames.inputToFrameMs?.p95 === undefined) failures.push('no input-driven frame');
    }
    failWhen(failures, 'gestureJankPercent', over(jank.jankyPercent, limits.gestureJankPercent));
    failWhen(failures, 'gestureP95Ms', over(jank.p95Ms, limits.gestureP95Ms));
    failWhen(failures, 'gestureP99Ms', over(jank.p99Ms, limits.gestureP99Ms));
    failWhen(failures, 'gestureOverFourFramesPercent', over(jank.overFourFramesPercent, limits.gestureOverFourFramesPercent));
    failWhen(failures, 'gestureDroppedPercent', over(frames.droppedPercent, limits.gestureDroppedPercent));
    failWhen(failures, 'missedVsyncPerFling', over(jank.missedVsync, limits.missedVsyncPerFling));
    failWhen(failures, 'inputToFrameP95Ms', over(frames.inputToFrameMs?.p95, limits.inputToFrameP95Ms));

    if (NATIVE_PHASES.has(name)) {
        failWhen(failures, 'jsBusyDeltaNative', over(metrics.jsBusyDeltaPoints, limits.jsBusyDeltaNative));
    }
    if (TERMINAL_PHASES.has(name)) {
        failWhen(failures, 'jsBusyDeltaTerminal', over(metrics.jsBusyDeltaPoints, limits.jsBusyDeltaTerminal));
    }
    failWhen(failures, 'accidentalOwners', over(metrics.accidentalOwners, limits.accidentalOwners));

    if (name === 'terminal text fling') {
        failWhen(failures, 'terminalScrollP95Ms', over(terminal.scrollLatencyP95Ms, limits.terminalScrollP95Ms));
        failWhen(failures, 'terminalRowsPerSecond', under(terminal.rowsPerSecond, limits.terminalRowsPerSecond));
        failWhen(failures, 'terminalScrollClamped', over(terminal.clamped, limits.terminalScrollClamped));
        failWhen(failures, 'accidentalOwners', over(terminal.agentPages, limits.accidentalOwners));
    }
    if (name === 'graphics pane scroll') {
        failWhen(failures, 'graphicsRowsPerSecond', under(terminal.rowsPerSecond ?? metrics.graphicsRowsPerSecond, limits.graphicsRowsPerSecond));
    }
    if (name === 'zoom tap navigate') {
        failWhen(failures, 'zoomTapped', metrics.zoomTapped !== true);
        // Which surface answered the tap decides what the proof is, so a run
        // that could not tell reports that rather than picking the easier one.
        // A text pane zooms by re-gridding, which the phone reports; a graphics
        // pane holds the remote grid and magnifies its own surface, which only
        // its pixels can show.
        if (metrics.zoomSurface === 'text') {
            failWhen(failures, 'zoomResizeCount', metrics.zoomResizeCount !== limits.zoomResizeCount);
            // The phone's own trail has to show the same one re-grid the host
            // recorded; a step only one of them saw is not a step.
            failWhen(failures, 'the phone trail does not match the host zoom re-grid',
                metrics.zoomPhoneResizeCount !== limits.zoomResizeCount);
        } else if (metrics.zoomSurface === 'graphics') {
            failWhen(failures, 'zoom did not magnify the surface', metrics.zoomMagnified?.proven !== true);
            failWhen(failures, 'zoomResizeCount', (metrics.zoomResizeCount ?? 0) !== 0);
            failWhen(failures, 'the phone trail re-gridded a graphics zoom', (metrics.zoomPhoneResizeCount ?? 0) !== 0);
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
