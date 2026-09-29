import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { historyLog } from '@/catalog/ops';

type Log = Awaited<ReturnType<typeof historyLog>>;

/**
 * The session repository's git history over host-run git. Product surface
 * (the history half of the retired Files add-on); the session cwd never
 * travels from the client — the host injects it.
 */
export default function CommitsScreen() {
    const router = useRouter();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const { theme } = useUnistyles();
    const [log, setLog] = React.useState<Log | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        let cancelled = false;
        historyLog(sessionId)
            .then((result) => {
                if (cancelled) return;
                setLog(result);
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
    }, [sessionId]);

    return (
        <>
            <Stack.Screen options={{ title: log?.title ?? 'Git history' }} />
            <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
                {loading
                    ? <ActivityIndicator color={theme.colors.textSecondary} />
                    : error !== undefined
                        ? <Text style={{ color: theme.colors.textDestructive, fontSize: 14 }}>{error}</Text>
                        : <>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{log?.count}</Text>
                            {(log?.commits ?? []).map((commit) => (
                                <Pressable
                                    key={commit.sha}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Commit ${commit.subject}`}
                                    onPress={() => router.push({
                                        pathname: '/session/[id]/commit',
                                        params: { id: sessionId, sha: commit.sha },
                                    })}
                                    style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                                >
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ color: theme.colors.text, fontSize: 15 }} numberOfLines={1}>{commit.subject}</Text>
                                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{commit.meta}</Text>
                                    </View>
                                    <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                </Pressable>
                            ))}
                            {(log?.commits.length ?? 0) === 0 && <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>No commits</Text>}
                        </>}
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 },
    content: { padding: 16, gap: 4 },
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 8, borderRadius: 8 },
});
