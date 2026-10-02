/**
 * Pane summaries run on this phone through BYOKit's on-device generation kit
 * and nothing else: no provider, cloud or raw model SDK behind them. These are
 * the kit's six states as the summary sheet presents them.
 */
export type OnDeviceGenerationState =
    | { kind: 'unsupported'; reason: 'device' | 'unpublished' }
    | { kind: 'needs-download'; bytes?: number }
    | { kind: 'downloading'; fraction?: number }
    | { kind: 'ready' }
    | { kind: 'busy' }
    | { kind: 'failed'; message: string };

export type OnDeviceSummarizer = {
    state: OnDeviceGenerationState;
    /** Present only while the kit can fetch its model. */
    download?: () => void;
    /** Present only when the kit is ready; resolves to the kit's own text. */
    summarize?: (output: string) => Promise<string>;
};

const UNPUBLISHED: OnDeviceSummarizer = { state: { kind: 'unsupported', reason: 'unpublished' } };

/**
 * The summarizer for this phone. The on-device kit is not published yet, so
 * this says so rather than pretending: no download, no generation.
 */
// ponytail: fixed until the published byk-ondevice-kit pin replaces this body with the kit's state and calls.
export function useOnDeviceSummarizer(): OnDeviceSummarizer {
    return UNPUBLISHED;
}

const MAX_INPUT_CHARS = 8_000;

/** The pane's latest output, without blank runs, cut to what a phone model reads. */
export function summaryInput(output: string): string {
    const text = output.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').join('\n');
    return text.length > MAX_INPUT_CHARS ? text.slice(text.length - MAX_INPUT_CHARS) : text;
}

/** At most four lines of whatever the kit wrote. */
export function summaryLines(summary: string): string[] {
    return summary.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, 4);
}
