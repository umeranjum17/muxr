import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { pairingDeviceNoun, usePairQrScannerAvailable, useHostedPairing, usePairQrScanner } from '@/pairing';
import { ActionButton } from '@/components/ActionButton';
import { OnboardingStepHeader } from '@/components/OnboardingStepHeader';
import { WordWrappingText } from '@/components/WordWrappingText';
import { useCompactWindow } from '@/components/useCompactWindow';
import { loadAppConfig } from '@/catalog';
import { addComputerLink, setupEmptyState } from '@/commercialization';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { openTailscaleStore } from './tailscaleApp';

// The My computer door's branch: Get ready (Tailscale, muxr on the computer),
// then Pair. Its third step, starting an agent, is Home's first-agent card,
// which pairing lands on. Each step is its own screen in the stack, so Back
// walks the branch. Paste and Scan share the existing validator and consent
// route; this branch does not claim an offer or store a grant.
export function MyComputerSetup() {
    const params = useLocalSearchParams<{ step?: string }>();
    const insets = useSafeAreaInsets();
    const styles = stylesheet;
    return (
        <ScrollView
            style={styles.screen}
            contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.column}>
                {params.step === 'pair' ? <PairStep /> : <ReadyStep />}
            </View>
        </ScrollView>
    );
}

function StepCard(props: { title: string; time: string; children: React.ReactNode }) {
    const styles = stylesheet;
    return (
        <View style={styles.card}>
            <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>{props.title}</Text>
                <Text style={styles.cardTime}>{props.time}</Text>
            </View>
            {props.children}
        </View>
    );
}

function ReadyStep() {
    const router = useRouter();
    const styles = stylesheet;
    const browser = Platform.OS === 'web';
    const device = browser ? 'device' : pairingDeviceNoun();
    const desktopLink = addComputerLink();
    const setupUrl = setupEmptyState(loadAppConfig().publicBaseUrl).setupUrl;
    return (
        <>
            <OnboardingStepHeader step={1} of={3} time="about 3–4 min" title="Get ready" subtitle="Two things on your computer, once. Then you pair." />
            <StepCard title="1 · Tailscale on both ends" time="about 2 min">
                <Text style={styles.hint}>{`Install the free Tailscale app on this ${device} and on your computer. Sign in to the same account on both. Skip this if both already have it.`}</Text>
                <ActionButton variant="secondary" title="Get Tailscale" icon="download-outline" wrap action={openTailscaleStore} />
            </StepCard>
            <StepCard title="2 · muxr on the computer" time="about 1–2 min">
                {desktopLink !== undefined ? (
                    <>
                        <Text style={styles.hint}>Open the desktop app’s download link on your computer. It opens and shows a QR to pair.</Text>
                        <ActionButton
                            variant="secondary"
                            title="Get the desktop app"
                            icon="laptop-outline"
                            wrap
                            accessibilityLabel="Get the desktop app. Open its download link on your computer."
                            onPress={() => router.push('/add-computer')}
                        />
                        <Text style={styles.hint}>Rather use a terminal? Run <Text style={styles.command}>muxr</Text> there.</Text>
                    </>
                ) : (
                    <Text style={styles.hint}>
                        On the computer, open a terminal and run <Text style={styles.command}>muxr</Text>, then <Text style={styles.command}>muxr link</Text>.
                        {browser ? ' It prints a link for this browser.' : ' It shows a QR and a link to pair.'}
                    </Text>
                )}
                {setupUrl !== undefined && (
                    <Pressable accessibilityRole="link" style={styles.linkTarget} onPress={() => { void openExternalUrl(setupUrl); }}>
                        <Text style={styles.link}>muxr not installed? Setup guide</Text>
                    </Pressable>
                )}
            </StepCard>
            {/* A string href: on web the object form with params pushed /pair. */}
            <ActionButton title="Next: pair" icon="arrow-forward-outline" wrap onPress={() => router.push('/my-computer?step=pair')} />
        </>
    );
}

function PairStep() {
    const styles = stylesheet;
    const browser = Platform.OS === 'web';
    const [linkValue, setLinkValue] = React.useState('');
    const processPairLink = useHostedPairing();
    const canScan = usePairQrScannerAvailable();
    const scanPairQr = usePairQrScanner(processPairLink, canScan);
    const connectLink = React.useCallback(() => {
        void processPairLink(linkValue.trim());
    }, [processPairLink, linkValue]);
    // An empty field makes the button Paste a link: the computer's link from
    // `muxr link`, copied on this device, pairs from one tap.
    const pasteLink = React.useCallback(() => {
        void Clipboard.getStringAsync().then((text) => {
            setLinkValue(text);
            void processPairLink(text.trim());
        }, () => undefined);
    }, [processPairLink]);
    const empty = linkValue.trim() === '';
    return (
        <>
            <OnboardingStepHeader step={2} of={3} time="about 30 s" title="Pair with your computer" subtitle="One scan or one paste, then compare two words." />
            {canScan && (
                <View style={styles.card}>
                    <ActionButton title="Scan the QR" icon="qr-code-outline" wrap onPress={() => { void scanPairQr(); }} />
                    <Text style={styles.hint}>On your computer, run <Text style={styles.command}>muxr link</Text>, or open the desktop app. Scan the QR it shows.</Text>
                </View>
            )}
            <View style={styles.card}>
                <Text style={styles.inputLabel}>Private link or pairing code</Text>
                <TextInput
                    accessibilityLabel="Private link or pairing code"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="go"
                    placeholder="Paste link"
                    placeholderTextColor={styles.inputPlaceholder.color}
                    style={styles.input}
                    value={linkValue}
                    onChangeText={setLinkValue}
                    onSubmitEditing={connectLink}
                />
                <ActionButton
                    variant={canScan ? 'secondary' : 'primary'}
                    title={empty && !browser ? 'Paste a link' : 'Connect'}
                    icon="link-outline"
                    wrap
                    onPress={empty && !browser ? pasteLink : connectLink}
                />
                {!canScan && (
                    <Text style={styles.hint}>{browser
                        ? 'Paste the browser link that muxr link shows on your computer. A browser can’t scan a QR.'
                        : `This ${pairingDeviceNoun()} can't scan a QR, so paste the pairing string muxr shows on your computer.`}</Text>
                )}
            </View>
            <View style={styles.card}>
                <Text style={styles.cardTitle}>Then check two words</Text>
                <Text style={styles.hint}>The same two words show here and on your computer. If they match, approve on the computer.</Text>
                <ExampleWords />
                <Text style={styles.example}>Example words</Text>
            </View>
            <StepCard title="Next · Start an agent" time="about 30 s">
                <Text style={styles.hint}>Pairing lands you on Home. Start your first agent there and it opens in a terminal on your computer.</Text>
            </StepCard>
        </>
    );
}

// In a narrow window the two words stack, each as wide as the card, and a
// word wider than that scales down instead of breaking.
function ExampleWords() {
    const styles = stylesheet;
    const compact = useCompactWindow();
    return (
        <View style={[styles.words, compact && styles.wordsStacked]}>
            {['harbor', 'lantern'].map((word) => compact
                ? <View key={word} style={styles.wordChip}><WordWrappingText fontSize={18} lineHeight={24} style={styles.wordText}>{word}</WordWrappingText></View>
                : <Text key={word} style={[styles.wordChip, styles.wordText]}>{word}</Text>)}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    screen: { flex: 1 },
    content: { flexGrow: 1, paddingTop: 18, paddingHorizontal: 16 },
    column: { alignSelf: 'center', width: '100%', maxWidth: 440, gap: 16 },
    card: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 14,
        gap: 10,
    },
    cardHead: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: 8, rowGap: 2 },
    cardTitle: { ...Typography.default('semiBold'), flexShrink: 1, fontSize: 15, lineHeight: 20, color: theme.colors.text },
    cardTime: { ...Typography.mono(), fontSize: 12, color: theme.colors.textSecondary },
    hint: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    command: { ...Typography.mono(), color: theme.colors.text },
    linkTarget: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    link: { ...Typography.default('semiBold'), fontSize: 13, textDecorationLine: 'underline', color: theme.colors.text },
    inputLabel: { ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.text },
    input: {
        ...Typography.default(),
        minHeight: 50,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        color: theme.colors.text,
        paddingHorizontal: 14,
        fontSize: 16,
    },
    inputPlaceholder: { color: theme.colors.textSecondary },
    words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
    wordsStacked: { flexDirection: 'column', alignItems: 'stretch' },
    wordChip: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        overflow: 'hidden',
    },
    wordText: { ...Typography.mono('semiBold'), fontSize: 18, textAlign: 'center', color: theme.colors.text },
    example: { ...Typography.mono(), fontSize: 11, textAlign: 'center', letterSpacing: 0.4, color: theme.colors.textSecondary },
}));
