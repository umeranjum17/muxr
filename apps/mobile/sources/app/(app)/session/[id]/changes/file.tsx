import React from 'react';
import { ScrollView, View, Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { PatchSurface } from '@/components/diff/PatchSurface';
import { changesPatch } from '@/catalog/ops';

type PatchResult = Awaited<ReturnType<typeof changesPatch>>;

/**
 * One file's patch inside the comparison the review screen listed. The pins
 * (head/base) come from that listing, so a stale deep link cannot diff the
 * wrong commits — the host rejects unpinned or changed comparisons.
 */
export default function ChangesFileScreen() {
    const { theme } = useUnistyles();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const params = useLocalSearchParams<{
        path: string; root?: string; scope?: string; kind?: string; head?: string; base?: string;
    }>();
    const [result, setResult] = React.useState<PatchResult | undefined>(undefined);
    const [error, setError] = React.useState<string | undefined>(undefined);

    const path = typeof params.path === 'string' ? params.path : '';
    const root = typeof params.root === 'string' ? params.root : undefined;
    const scope = typeof params.scope === 'string' ? params.scope as 'working' | 'staged' | 'branch' : undefined;
    const kind = typeof params.kind === 'string' ? params.kind as 'working' | 'staged' | 'branch' | 'untracked' : undefined;
    const head = typeof params.head === 'string' ? params.head : undefined;
    const base = typeof params.base === 'string' ? params.base : undefined;

    React.useEffect(() => {
        let cancelled = false;
        changesPatch(sessionId, { path, ...(kind === undefined ? {} : { kind }), ...(head === undefined ? {} : { head }), ...(base === undefined ? {} : { base }) }, {
            ...(root === undefined ? {} : { root }), ...(scope === undefined ? {} : { scope }),
        })
            .then((patch) => {
                if (!cancelled) setResult(patch);
            })
            .catch((cause: unknown) => {
                if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
            });
        return () => { cancelled = true; };
    }, [sessionId, path, root, scope, kind, head, base]);

    return (
        <>
            <Stack.Screen options={{ title: result?.title ?? path.split('/').pop() ?? 'Diff' }} />
            <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
                {result !== undefined && (
                    <Text style={[styles.note, { color: theme.colors.textSecondary }]} selectable>
                        {result.note}
                    </Text>
                )}
                {error !== undefined && (
                    <Text style={[styles.note, { color: theme.colors.gitRemovedText }]} selectable>{error}</Text>
                )}
                {result !== undefined && result.patch !== '' && <PatchSurface patch={result.patch} />}
                {result !== undefined && result.patch === '' && (
                    <View style={styles.empty}>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>No difference in this comparison.</Text>
                    </View>
                )}
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.groupped.background },
    content: { paddingBottom: 32 },
    note: { fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 },
    empty: { padding: 24, alignItems: 'center' },
}));
