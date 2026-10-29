import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { billingWords, provider } from '@byokit/accounts';
import { ActionButton } from '@/components/ActionButton';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { PHONE_ACCOUNT } from '../domain/phone';
import type { PhoneStage } from '../application/usePhoneChat';

const plan = provider(PHONE_ACCOUNT);

/** Sign in to the account the person already pays for; the code goes in on ChatGPT's own page. */
export function PhoneSignIn(props: {
    stage: Extract<PhoneStage, { kind: 'signed-out' | 'signing-in' }>;
    onSignIn: () => void;
    onCancel: () => void;
}) {
    const { stage } = props;
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);
    if (stage.kind === 'signing-in') {
        return (
            <View style={styles.section}>
                <Text style={styles.title}>Enter this code on ChatGPT</Text>
                <Text style={styles.body}>Open ChatGPT, sign in, and type the code below when it asks.</Text>
                <View style={styles.codeCard} accessibilityLabel={`Your code is ${stage.code.split('').join(' ')}`}>
                    <Text style={styles.code}>{stage.code}</Text>
                </View>
                <ActionButton title="Open ChatGPT" icon="open-outline" onPress={() => { void openExternalUrl(stage.url, { freshPage: true }); }} />
                <ActionButton
                    variant="secondary"
                    title={copied ? 'Copied' : 'Copy the code'}
                    icon="copy-outline"
                    onPress={() => { void Clipboard.setStringAsync(stage.code).then(() => setCopied(true)); }}
                />
                <View style={styles.waiting}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    <Text style={styles.hint}>Waiting for you to finish on ChatGPT…</Text>
                </View>
                <ActionButton variant="quiet" title="Cancel" onPress={props.onCancel} />
            </View>
        );
    }
    return (
        <View style={styles.section}>
            <View style={styles.badge}>
                <Ionicons name="phone-portrait-outline" size={26} color={styles.badgeIcon.color} />
            </View>
            <Text style={styles.title}>Talk to an agent on this phone</Text>
            <Text style={styles.body}>No computer needed. Sign in with the AI plan you already pay for, then ask for something.</Text>
            {stage.note !== undefined && <Text style={styles.error} accessibilityRole="alert">{stage.note}</Text>}
            <ActionButton title="Sign in with ChatGPT" icon="log-in-outline" onPress={props.onSignIn} />
            <Text style={styles.hint}>{plan ? billingWords(plan) : 'Uses your ChatGPT plan.'} Your sign-in stays on this phone.</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: { width: '100%', gap: 14 },
    badge: {
        width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    badgeIcon: { color: theme.colors.text },
    title: { ...Typography.default('semiBold'), fontSize: 24, lineHeight: 30, color: theme.colors.text },
    body: { ...Typography.default(), fontSize: 15, lineHeight: 21, color: theme.colors.textSecondary },
    hint: { ...Typography.default(), flexShrink: 1, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    error: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.textDestructive },
    codeCard: {
        alignItems: 'center', paddingVertical: 18, paddingHorizontal: 12, borderRadius: 12,
        borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh,
    },
    code: { ...Typography.mono('semiBold'), fontSize: 28, letterSpacing: 3, color: theme.colors.text },
    waiting: { flexDirection: 'row', alignItems: 'center', gap: 10 },
}));
