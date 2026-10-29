import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { usePhoneChat } from '../application/usePhoneChat';
import { PhoneChat } from './PhoneChat';
import { PhoneSignIn } from './PhoneSignIn';

/** "Just this phone": sign in on the phone, then talk to an agent that runs on it. */
export function PhoneScreen() {
    const chat = usePhoneChat();
    const { stage } = chat;
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const startOver = React.useCallback(() => {
        void Modal.confirm('Start over?', 'This clears the chat and signs out of ChatGPT on this phone.', { confirmText: 'Start over', destructive: true })
            .then((yes) => { if (yes) void chat.startOver(); });
    }, [chat]);
    React.useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: stage.kind === 'ready'
                ? () => (
                    <Pressable accessibilityRole="button" accessibilityLabel="Start over" hitSlop={8} onPress={startOver}>
                        <Ionicons name="trash-outline" size={24} color={theme.colors.header.tint} />
                    </Pressable>
                )
                : undefined,
        });
    }, [navigation, stage.kind, startOver, theme]);
    return (
        <View style={styles.screen}>
            {stage.kind === 'loading' && <View style={styles.center}><ActivityIndicator /></View>}
            {(stage.kind === 'signed-out' || stage.kind === 'signing-in') && (
                <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                    <PhoneSignIn stage={stage} onSignIn={() => { void chat.signIn(); }} onCancel={chat.cancelSignIn} />
                </ScrollView>
            )}
            {stage.kind === 'ready' && (
                <PhoneChat account={stage.account} turns={chat.turns} busy={chat.busy} onSend={(text) => { void chat.send(text); }} onTryAgain={(id) => { void chat.tryAgain(id); }} />
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.groupped.background },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    content: { flexGrow: 1, width: '100%', maxWidth: 440, alignSelf: 'center', padding: 16, paddingTop: 24, paddingBottom: 32 },
}));
