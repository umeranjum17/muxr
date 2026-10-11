import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DesktopView, useDesktopSession } from '@desklink/react-native';
import { Ionicons } from '@expo/vector-icons';

import { Typography } from '@/constants/Typography';
import { sync } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { createDesktopSignaling } from '../application/desktopSignaling';
import { describeDesktopFailureDetail } from '../model/desktopOverlay';
import { readDecoderStats, type DecoderReading } from '../model/decoderStats';

/** The receiver asks for H.264 first on iOS; 30 fps is the documented iOS cap. */
const DEBUG_MAX_FPS = 30;

/** How often the screen refreshes the receiver's own counters. */
const POLL_MS = 1000;

const ROWS: readonly { key: keyof DecoderReading; label: string }[] = [
    { key: 'decoder', label: 'Decoder' },
    { key: 'fps', label: 'Frames per second' },
    { key: 'codec', label: 'Codec' },
    { key: 'resolution', label: 'Picture size' },
    { key: 'framesDecoded', label: 'Frames decoded' },
    { key: 'framesDropped', label: 'Frames dropped' },
    { key: 'packetsLost', label: 'Packets lost' },
];

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface },
    stage: { flex: 1, backgroundColor: '#000' },
    readout: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 6,
    },
    heading: {
        fontSize: 12,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
    label: { fontSize: 14, color: theme.colors.textSecondary, ...Typography.default() },
    value: { flexShrink: 1, textAlign: 'right', fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') },
    message: { fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() },
}));

/**
 * The developer decoder probe: it opens the current computer's desktop and
 * shows the receiver's own decoder and frame-rate counters, exactly as
 * `@desklink/react-native` reports them. It exists to prove which decoder a
 * platform runs (hardware H.264 on iOS) and is reachable only while the app's
 * developer flag is on.
 */
export function DecoderStatsScreen() {
    const { theme } = useUnistyles();
    const [reading, setReading] = React.useState<DecoderReading>(() => readDecoderStats(undefined));
    const [error, setError] = React.useState<string | null>(null);
    const [statsSeen, setStatsSeen] = React.useState(false);

    const session = useDesktopSession({
        authorize: React.useCallback(async () => {
            const capabilities = await sync.request('desktop.capabilities', {}).catch(() => null);
            const canClipboard = capabilities?.clipboard === true;
            const permissions: Array<'view' | 'control' | 'clipboard'> = canClipboard ? ['view', 'control', 'clipboard'] : ['view', 'control'];
            return {
                signaling: createDesktopSignaling({ permissions, maxFps: DEBUG_MAX_FPS }),
                session: { permissions },
            };
        }, []),
        onError: (failure) => setError(describeDesktopFailureDetail(failure)),
    });
    const { connect, getStats, snapshot } = session;

    React.useEffect(() => {
        void connect();
    }, [connect]);

    React.useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            try {
                const report = await getStats();
                if (cancelled) return;
                setStatsSeen(true);
                setReading(readDecoderStats(report));
            } catch (failure) {
                if (cancelled) return;
                setError(failure instanceof Error ? failure.message : 'could not read the receiver statistics');
            }
        };
        void tick();
        const timer = setInterval(() => void tick(), POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [getStats]);

    return (
        <View style={styles.screen}>
            <DesktopView
                sessionId={session.nativeId}
                style={styles.stage}
                accessibilityLabel="Desktop decoder probe"
            />
            <ScrollView style={styles.readout} contentContainerStyle={{ gap: 6 }}>
                <Text style={styles.heading}>Receiver statistics</Text>
                <Text style={styles.message}>
                    {snapshot.status === 'live'
                        ? 'Live desktop · what the decoder reports right now'
                        : `Session ${snapshot.status} · values read from the receiver as they arrive`}
                </Text>
                {ROWS.map(({ key, label }) => (
                    <View key={key} style={styles.row}>
                        <Text style={styles.label}>{label}</Text>
                        <Text selectable style={styles.value}>{reading[key]}</Text>
                    </View>
                ))}
                {!statsSeen && <Text style={styles.message}>No receiver statistics yet.</Text>}
                {error !== null && (
                    <View style={styles.row}>
                        <Ionicons name="warning-outline" size={14} color={theme.colors.box.warning.text} />
                        <Text style={[styles.message, { color: theme.colors.box.warning.text }]}>{error}</Text>
                    </View>
                )}
            </ScrollView>
        </View>
    );
}
