import * as React from 'react';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FirstRunConnection } from '@/herd/ui';

/** The two doors on their own route, for a browser that starts on the sample herd. */
export default function ConnectPage() {
    const insets = useSafeAreaInsets();
    return (
        <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}>
            <FirstRunConnection />
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 },
    content: { flexGrow: 1, alignItems: 'center', paddingTop: 22, paddingHorizontal: 16 },
});
