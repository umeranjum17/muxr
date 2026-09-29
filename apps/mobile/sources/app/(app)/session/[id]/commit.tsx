import React from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { NavigableDiff } from '@/components/diff/NavigableDiff';
import { PLUGIN_CODE_MAX_CHARS, PLUGIN_CODE_MAX_LINES } from '@/components/code/CodeCore';
import { boundText } from '@/utils/boundedText';
import { historyShow } from '@/catalog/ops';

type Shown = Awaited<ReturnType<typeof historyShow>>;

/** One commit's patch, capped — the product half of the retired history screen. */
export default function CommitScreen() {
    const { id: sessionId, sha } = useLocalSearchParams<{ id: string; sha: string }>();
    const { theme } = useUnistyles();
    const [shown, setShown] = React.useState<Shown | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        let cancelled = false;
        historyShow(sessionId, typeof sha === 'string' ? sha : undefined)
            .then((result) => {
                if (cancelled) return;
                setShown(result);
                setError(undefined);
            })
            .catch((cause: unknown) => {
                if (cancelled) return;
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [sessionId, sha]);

    return (
        <>
            <Stack.Screen options={{ title: shown?.subject ?? 'Commit' }} />
            <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
                {loading
                    ? <ActivityIndicator color={theme.colors.textSecondary} />
                    : error !== undefined
                        ? <Text style={{ color: theme.colors.textDestructive, fontSize: 14 }}>{error}</Text>
                        : <>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{shown?.meta}</Text>
                            <View style={{ marginBottom: 10 }}>
                                <NavigableDiff patch={boundText(shown?.patch ?? '', PLUGIN_CODE_MAX_LINES, PLUGIN_CODE_MAX_CHARS).text} />
                            </View>
                        </>}
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 },
    content: { padding: 16, gap: 8 },
});
