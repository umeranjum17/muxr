import * as React from 'react';
import { AppState } from 'react-native';
import { InferError, errorWords, summarizePane, summaryWords, words, type InferState, type LocalModel, type WordKey } from '@byokit/infer';
import { openOnDeviceModel } from '../infrastructure/onDeviceModel';

/**
 * Pane summaries run on this phone through BYOKit's on-device generation kit
 * and nothing else: no provider, cloud or raw model SDK behind them. These are
 * the kit's six states as the summary sheet presents them.
 */
export type OnDeviceGenerationState =
    | { kind: 'unsupported'; reason: 'device' | 'build' }
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

let kit: LocalModel | null | undefined;
let phase: InferState = { phase: 'not-installed' };
const listeners = new Set<() => void>();

function publish(next: InferState): void {
    phase = next;
    listeners.forEach((listener) => listener());
}

function onDeviceModel(): LocalModel | null {
    if (kit !== undefined) return kit;
    kit = openOnDeviceModel(publish);
    if (kit !== null) { phase = kit.state; void kit.check().catch(() => undefined); }
    return kit;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

// `storage` covers more than a full disk, so only the kit's own error says which.
const FAILED_WORDS: Partial<Record<NonNullable<InferState['why']>, WordKey>> = { integrity: 'infer.integrity', network: 'infer.network' };
let installError: InferError | undefined;

function presented(state: InferState, model: LocalModel): OnDeviceGenerationState {
    switch (state.phase) {
        case 'unsupported': return { kind: 'unsupported', reason: state.why === 'binding' ? 'build' : 'device' };
        case 'not-installed': return { kind: 'needs-download', bytes: model.model.bytes };
        case 'installing': return { kind: 'downloading', fraction: state.total ? (state.received ?? 0) / state.total : undefined };
        case 'installed':
        case 'ready': return { kind: 'ready' };
        case 'loading':
        case 'busy': return { kind: 'busy' };
        case 'failed': return { kind: 'failed', message: state.why === 'storage' && installError ? errorWords(installError) : words((state.why && FAILED_WORDS[state.why]) || 'infer.failed') };
    }
}

/**
 * The summarizer for this phone, over BYOKit's on-device kit. The kit owns the
 * prompt, redaction and the 3–4 line shape; the model is released when the
 * sheet closes or the app leaves the foreground.
 */
export function useOnDeviceSummarizer(): OnDeviceSummarizer {
    const model = onDeviceModel();
    const state = React.useSyncExternalStore(subscribe, () => phase);
    React.useEffect(() => {
        if (model === null) return;
        const background = AppState.addEventListener('change', (next) => { if (next === 'background') void model.release(); });
        return () => { background.remove(); void model.release(); };
    }, [model]);
    if (model === null) return { state: { kind: 'unsupported', reason: 'build' } };
    const shown = presented(state, model);
    return {
        state: shown,
        download: shown.kind === 'needs-download' || shown.kind === 'failed' ? () => {
            installError = undefined;
            void model.install().catch((reason: unknown) => { if (reason instanceof InferError) { installError = reason; publish({ ...phase }); } });
        } : undefined,
        summarize: shown.kind === 'ready' ? async (output) => {
            const summary = await summarizePane(model, output.split('\n')).catch((reason: unknown) => {
                throw reason instanceof InferError ? new Error(errorWords(reason)) : reason;
            });
            if (!summary.ok) throw new Error(summaryWords(summary.code));
            return summary.lines.join('\n');
        } : undefined,
    };
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
