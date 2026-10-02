import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { sync } from '@/catalog/sync';
import { ActionButton } from '@/components/ActionButton';
import { summaryInput, summaryLines, useOnDeviceSummarizer, type OnDeviceGenerationState } from '../application/paneSummary';

type Run =
    | { kind: 'idle' }
    | { kind: 'working'; step: 'Reading output…' | 'Summarizing on this phone…' }
    | { kind: 'done'; lines: string[] }
    | { kind: 'error'; message: string };

function stateNote(state: OnDeviceGenerationState): string {
    switch (state.kind) {
        case 'unsupported': return state.reason === 'device'
            ? 'This phone can’t run on-device summaries.'
            : 'On-device summaries aren’t available in this build yet.';
        case 'needs-download': return `Summaries run on this phone. Download the model first${state.bytes === undefined ? '' : ` (${Math.ceil(state.bytes / 1_000_000)} MB)`}.`;
        case 'downloading': return state.fraction === undefined ? 'Downloading the model…' : `Downloading the model… ${Math.round(state.fraction * 100)}%`;
        case 'ready': return 'A short summary of this pane’s latest output, made on this phone.';
        case 'busy': return 'The on-device model is busy. Try again in a moment.';
        case 'failed': return state.message;
    }
}

/** A 3–4 line summary of the pane's recent output, generated only by the on-device kit. */
export function PaneSummarySheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const summarizer = useOnDeviceSummarizer();
    const { state } = summarizer;
    const [run, setRun] = React.useState<Run>({ kind: 'idle' });
    const generation = React.useRef(0);
    React.useEffect(() => () => { generation.current++; }, []);
    const summarize = summarizer.summarize;
    const start = React.useCallback(async () => {
        if (summarize === undefined) return;
        const current = ++generation.current;
        try {
            setRun({ kind: 'working', step: 'Reading output…' });
            const read = await sync.request('pane.read', { sessionId, source: 'recent', lines: 400 });
            const input = summaryInput(read.text);
            if (current !== generation.current) return;
            if (input === '') { setRun({ kind: 'error', message: 'No output to summarize yet.' }); return; }
            setRun({ kind: 'working', step: 'Summarizing on this phone…' });
            const lines = summaryLines(await summarize(input));
            if (current !== generation.current) return;
            setRun(lines.length === 0 ? { kind: 'error', message: 'The model returned no summary.' } : { kind: 'done', lines });
        } catch (reason) {
            if (current === generation.current) setRun({ kind: 'error', message: reason instanceof Error ? reason.message : 'Could not summarize' });
        }
    }, [sessionId, summarize]);
    const secondary = theme.colors.textSecondary;
    const working = run.kind === 'working';
    let note = stateNote(state);
    if (run.kind === 'error') note = run.message;
    if (run.kind === 'working') note = run.step;
    return <View accessibilityViewIsModal style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50, justifyContent: 'flex-end', backgroundColor: theme.colors.scrim }}>
        <Pressable onPress={onClose} accessibilityLabel="Close Summarize" style={{ flex: 1 }} />
        <View style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingBottom: insets.bottom + 16, gap: 12, maxHeight: '85%' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 16 }}>
                <Text style={{ flex: 1, color: theme.colors.text, fontSize: 17, fontWeight: '600' }}>Summarize</Text>
                <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close summary" hitSlop={8}><Ionicons name="close" size={23} color={secondary} /></Pressable>
            </View>
            {run.kind === 'done'
                ? <View accessibilityLabel="Summary" style={{ borderRadius: 8, padding: 12, gap: 4, backgroundColor: theme.colors.surfaceHigh }}>
                    {run.lines.map((line, index) => <Text key={index} selectable style={{ color: theme.colors.text, fontSize: 15, lineHeight: 21 }}>{line}</Text>)}
                </View>
                : <Text style={{ color: secondary, fontSize: 14, lineHeight: 20 }}>{note}</Text>}
            {(working || state.kind === 'downloading') && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {state.kind === 'downloading' && state.fraction !== undefined
                    ? <View style={{ flex: 1, height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh }}>
                        <View style={{ width: `${Math.round(Math.min(1, Math.max(0, state.fraction)) * 100)}%`, height: 4, backgroundColor: theme.colors.accent }} />
                    </View>
                    : <ActivityIndicator color={theme.colors.accent} />}
            </View>}
            {state.kind === 'needs-download' && summarizer.download !== undefined
                && <ActionButton title="Download model" icon="cloud-download-outline" onPress={summarizer.download} />}
            {(state.kind === 'failed' && summarizer.download !== undefined)
                && <ActionButton title="Try download again" variant="secondary" icon="refresh" onPress={summarizer.download} />}
            {state.kind === 'ready' && summarize !== undefined && !working
                && <ActionButton title={run.kind === 'idle' ? 'Summarize output' : 'Summarize again'} icon={run.kind === 'idle' ? 'sparkles-outline' : 'refresh'}
                    variant={run.kind === 'idle' ? 'primary' : 'secondary'} onPress={() => { void start(); }} />}
        </View>
    </View>;
}
