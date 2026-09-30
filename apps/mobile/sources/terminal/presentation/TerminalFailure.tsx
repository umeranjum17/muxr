import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

export function TerminalFailure({ message, onHome }: { message: string; onHome: () => void }) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.colors.terminalChrome.canvas }} contentContainerStyle={{ flexGrow: 1, padding: 24, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24, justifyContent: 'center' }}>
            <View accessibilityRole="alert" style={{ gap: 16 }}>
                <Text style={{ color: theme.colors.text, fontSize: 22, fontWeight: '600' }}>Agent could not start</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 16, lineHeight: 24 }}>{message}</Text>
                <Pressable accessibilityRole="button" onPress={onHome} style={({ pressed }) => ({ alignSelf: 'flex-start', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh, opacity: pressed ? 0.7 : 1 })}>
                    <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>Back to Home</Text>
                </Pressable>
            </View>
        </ScrollView>
    );
}
