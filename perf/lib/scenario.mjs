/**
 * The one world every performance run measures, on either platform.
 *
 * Android and iOS ask different questions of the device, but they have to ask
 * them of the same app under the same load reading the same file. These were
 * two sets of literals -- Android scrolled 240 numbered lines, iOS scrolled a
 * different 2000-line README -- so a document number from one platform said
 * nothing about the other. Anything that describes the workload belongs here;
 * anything that measures it does not.
 */
import { createHash } from 'node:crypto';

/**
 * Bumped whenever the world or the payload below changes. Evidence carries it,
 * so a result measured against a different scenario cannot be read as this one.
 */
export const SCENARIO_VERSION = '1.0.0';

/** The load the host serves for the whole run. */
export const LOAD = {
    panes: 100,
    agents: 30,
    titleChurnHz: 2,
    terminalBytesPerSecond: 4096,
    graphicsFrameHz: 4,
};

/** The reading surface's fixture: one file, one payload, both platforms. */
export const DOCUMENT_FIXTURE = 'perf-document.md';
const DOCUMENT_LINES = 240;

/** 240 numbered lines: the file plugin's preview cap, and enough to scroll. */
export function documentPayload() {
    return `${Array.from(
        { length: DOCUMENT_LINES },
        (_, index) => `PERF_LINE_${String(index + 1).padStart(4, '0')} deterministic release-gate reading content with a long tail so the surface has somewhere to go.`,
    ).join('\n')}\n`;
}

/** The plugin's own read cap. What the app can show is bounded by this. */
export const SERVED_BYTE_LIMIT = 24 * 1024;

/**
 * What the app is actually served: the payload, its digest, and how much of it
 * survives the plugin's read cap. Generated line count and served line count
 * are different numbers, and a report that conflates them overstates coverage.
 */
export function documentContract() {
    const text = documentPayload();
    const bytes = Buffer.from(text, 'utf8');
    const served = bytes.subarray(0, Math.min(bytes.length, SERVED_BYTE_LIMIT)).toString('utf8');
    // The plugin splits what it read; a cap that lands mid-line still yields a
    // partial last line, and that line is on screen.
    const servedLines = served.split('\n').filter((line) => line !== '').length;
    return {
        name: DOCUMENT_FIXTURE,
        generatedLines: DOCUMENT_LINES,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        servedBytes: Math.min(bytes.length, SERVED_BYTE_LIMIT),
        servedLines,
        // The marker every reading-position proof looks for.
        marker: 'PERF_LINE_',
    };
}

/** One line for a report or a log: the world this run measured. */
export function scenarioSummary() {
    const document = documentContract();
    return `scenario ${SCENARIO_VERSION}: ${LOAD.panes} panes, ${LOAD.agents} agents,`
        + ` titles ${LOAD.titleChurnHz} Hz, terminal ${LOAD.terminalBytesPerSecond} B/s,`
        + ` graphics ${LOAD.graphicsFrameHz} Hz, document ${document.servedLines}/${document.generatedLines} lines served`;
}
