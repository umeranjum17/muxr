import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { claim, words } from '@byokit/cloud';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton } from '@/components/ActionButton';
import { setNativeSecret } from '@/pairing/secrets';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { Typography } from '@/constants/Typography';

const BOAT_API = 'https://boat.dev/api/v1';
const BOAT_KEY = 'muxr.cloud.boat-key.v1';
const STEPS = ['Provider', 'Your Boat account', 'Size and price', 'Create', 'Join your tailnet', 'Put muxr on it', 'Pair with this phone'];

type ClaimFailure = Extract<Awaited<ReturnType<typeof claim> extends AsyncIterable<infer T> ? T : never>, { step: 'failed' }>['why'];

function failureMessage(why: ClaimFailure): string {
    switch (why) {
        case 'refused': return words('claim.refused', { label: 'Boat' });
        case 'expired': return words('claim.expired');
        case 'unreachable': return 'Could not reach Boat. Check your connection and try again.';
        case 'provider': return 'Boat could not complete sign-in. Try again.';
    }
}

export function CloudSetupScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [email, setEmail] = React.useState('');
    const [url, setUrl] = React.useState<string>();
    const [code, setCode] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [connected, setConnected] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const controller = React.useRef<AbortController | undefined>(undefined);

    React.useEffect(() => () => controller.current?.abort(), []);

    const connect = React.useCallback(async () => {
        const address = email.trim();
        if (!address) {
            setError('Enter the email address for your Boat account.');
            return;
        }
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        setBusy(true);
        setError(undefined);
        setUrl(undefined);
        setCode(undefined);
        try {
            for await (const step of claim({ baseUrl: BOAT_API, email: address, signal: abort.signal })) {
                if (abort.signal.aborted) return;
                if (step.step === 'open-page') setUrl(step.url);
                if (step.step === 'type-code') {
                    setUrl(step.url);
                    setCode(step.code);
                }
                if (step.step === 'failed') throw new Error(failureMessage(step.why));
                if (step.step === 'done') {
                    await setNativeSecret(BOAT_KEY, step.key);
                    setConnected(true);
                    setBusy(false);
                }
            }
        } catch (cause) {
            if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            if (!abort.signal.aborted) setBusy(false);
        }
    }, [email]);

    if (Platform.OS === 'web') {
        return <View style={styles.webNotice}><Text style={styles.heading}>Your cloud computer</Text><Text style={styles.body}>Set up from the muxr phone app.</Text></View>;
    }

    return (
        <ScrollView style={{ marginBottom: insets.bottom }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.intro}>
                <Text style={styles.heading}>Your cloud computer</Text>
                <Text style={styles.eta}>About 3 min left</Text>
                <View style={styles.progress}><View style={[styles.progressFill, { width: connected ? '24%' : '10%' }]} /></View>
            </View>
            <View style={styles.list}>
                {STEPS.map((title, index) => {
                    const done = index === 0 || (index === 1 && connected);
                    const active = index === 1 && !connected;
                    return (
                        <View key={title} style={[styles.step, active && styles.activeStep]}>
                            <View style={[styles.number, done && styles.doneNumber]}>
                                {done ? <Ionicons name="checkmark" size={16} color={theme.colors.status.connected} /> : <Text style={styles.numberText}>{index + 1}</Text>}
                            </View>
                            <View style={styles.stepContent}>
                                <View style={styles.stepHeading}>
                                    <Text style={[styles.stepTitle, !active && !done && styles.todoTitle]}>{title}</Text>
                                    {(index === 0 || (index === 1 && connected)) && <Text style={styles.stepStatus}>{index === 0 ? 'Boat' : 'Connected'}</Text>}
                                </View>
                                {index === 0 && <Text style={styles.detail}>Boat · Hetzner later</Text>}
                                {active && (
                                    <View style={styles.form}>
                                        <Text style={styles.body}>Boat opens in your browser. Approve muxr there, then come back to this screen.</Text>
                                        <TextInput
                                            accessibilityLabel="Boat account email"
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            keyboardType="email-address"
                                            placeholder="Email address"
                                            placeholderTextColor={theme.colors.textSecondary}
                                            value={email}
                                            onChangeText={setEmail}
                                            style={styles.input}
                                        />
                                        {!url ? (
                                            <ActionButton title="Connect Boat account" icon="link-outline" disabled={busy} onPress={() => { void connect(); }} wrap />
                                        ) : (
                                            <ActionButton title="Sign in to Boat" icon="link-outline" disabled={busy} onPress={() => { void openExternalUrl(url).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} wrap />
                                        )}
                                        {url && code && <Text selectable style={styles.code}>Code · {code}</Text>}
                                        {busy && <View style={styles.waiting}><ActivityIndicator /><Text style={styles.detail}>Waiting for Boat…</Text></View>}
                                        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
                                        {!busy && error && <ActionButton title="Try again" variant="secondary" onPress={() => { void connect(); }} />}
                                        <Pressable accessibilityRole="link" onPress={() => { void openExternalUrl('https://boat.dev').catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}>
                                            <Text style={styles.createAccount}>No Boat account? Create one</Text>
                                        </Pressable>
                                    </View>
                                )}
                            </View>
                        </View>
                    );
                })}
            </View>
            {connected && <Text style={styles.leave}>Your Boat account is connected. Machine setup is the next step.</Text>}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    content: { alignSelf: 'center', width: '100%', maxWidth: 440, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 32, gap: 16 },
    webNotice: { flex: 1, padding: 24, gap: 12, justifyContent: 'center' },
    intro: { gap: 8 },
    heading: { ...Typography.default('semiBold'), fontSize: 24, lineHeight: 30, color: theme.colors.text },
    eta: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary },
    progress: { height: 4, borderRadius: 4, backgroundColor: theme.colors.divider, overflow: 'hidden' },
    progressFill: { height: 4, borderRadius: 4, backgroundColor: theme.colors.accent },
    list: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 14, overflow: 'hidden' },
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
    activeStep: { backgroundColor: theme.colors.surfaceHigh },
    number: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHighest },
    doneNumber: { backgroundColor: theme.colors.accentSubtle },
    numberText: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.textSecondary },
    stepContent: { flex: 1, minWidth: 0, gap: 8 },
    stepHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24 },
    stepTitle: { ...Typography.default('semiBold'), flexShrink: 1, fontSize: 15, color: theme.colors.text },
    todoTitle: { color: theme.colors.textSecondary },
    stepStatus: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary },
    detail: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    form: { gap: 10, paddingTop: 2 },
    body: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
    input: { ...Typography.default(), minHeight: 50, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12, paddingHorizontal: 14, color: theme.colors.text, fontSize: 16 },
    code: { ...Typography.default('semiBold'), fontSize: 18, letterSpacing: 2, color: theme.colors.text, textAlign: 'center', padding: 8 },
    waiting: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    error: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.status.disconnected },
    createAccount: { ...Typography.default('semiBold'), paddingVertical: 8, textAlign: 'center', color: theme.colors.textSecondary },
    leave: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary, textAlign: 'center' },
}));
