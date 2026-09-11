import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useMachine } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { getAppVersion } from '@/utils/appVersion';
import { versionsMismatch } from '@/utils/versionStatus';

/** Visible at Home, with one tap to the only detailed version/support screen. */
export function VersionNotice() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machine = useMachine(getCachedConnectionSettings().machineId);
    if (!versionsMismatch(getAppVersion(), machine?.metadata?.muxrCliVersion)) return null;
    return <Pressable accessibilityRole="button" accessibilityLabel="App and host versions differ. Review updates"
        onPress={() => router.push('/settings/connection')}
        style={({ pressed }) => ({ marginHorizontal: 16, marginVertical: 8, padding: 14, minHeight: 56,
            flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1,
            borderColor: theme.colors.box.warning.border, backgroundColor: theme.colors.box.warning.background,
            opacity: pressed ? 0.75 : 1 })}>
        <Ionicons name="warning-outline" size={22} color={theme.colors.box.warning.border} />
        <View style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.text, fontSize: 15, fontWeight: '600' }}>App and host versions differ</Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 3 }}>Review versions and update guidance</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.colors.text} />
    </Pressable>;
}
