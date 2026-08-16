import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { runShortcut } from '@/plugins/runShortcut';

/**
 * Assistant deep-link target. Home is restored first so the shortcut's action
 * lands on a mounted app rather than racing this screen's own teardown.
 */
export default function ShortcutRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    React.useEffect(() => {
        if (typeof id !== 'string' || id === '') return;
        router.replace('/');
        void runShortcut(id).catch(() => undefined);
    }, [id, router]);
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View>;
}
