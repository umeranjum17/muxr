import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Platform, ScrollView, Share, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import { qrMatrix } from '@byokit/ui-core/link';
import { Typography } from '@/constants/Typography';
import { loadAppConfig } from '@/catalog';
import { setupEmptyState } from '@/commercialization';
import { pairingDeviceNoun, useHostedPairing, usePairQrScanner, usePairQrScannerAvailable } from '@/pairing';
import { ActionButton } from '@/components/ActionButton';
import { WordWrappingText } from '@/components/WordWrappingText';
import { useCompactWindow } from '@/components/useCompactWindow';

/**
 * The desktop app's download link, or undefined where this screen cannot finish:
 * a build with no public site has no link, and a browser cannot pair with the
 * desktop app, which offers only phone (native) codes.
 */
export function addComputerLink(): string | undefined {
    if (Platform.OS === 'web') return undefined;
    return setupEmptyState(loadAppConfig().publicBaseUrl).desktopUrl;
}

/** The link's QR, dark on white in both themes so any camera reads it. */
function LinkQr(props: { text: string; size: number }) {
    const matrix = React.useMemo(() => qrMatrix(props.text, { border: 2 }), [props.text]);
    const path = React.useMemo(() => matrix.flatMap((row, y) =>
        row.flatMap((dark, x) => dark ? [`M${x} ${y}h1v1h-1z`] : [])).join(''), [matrix]);
    return (
        <View accessible accessibilityRole="image" accessibilityLabel="QR code for the link" style={stylesheet.qr}>
            <Svg width={props.size} height={props.size} viewBox={`0 0 ${matrix.length} ${matrix.length}`}>
                <Rect width={matrix.length} height={matrix.length} fill="#ffffff" />
                <Path d={path} fill="#000000" />
            </Svg>
        </View>
    );
}

function Step(props: { number: number; title: string; children?: React.ReactNode }) {
    const styles = stylesheet;
    return (
        <View style={styles.card}>
            <View style={styles.stepHead}>
                <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{props.number}</Text></View>
                <Text style={styles.stepTitle}>{props.title}</Text>
            </View>
            {props.children}
        </View>
    );
}

/**
 * Phone-first setup of a computer: the phone hands over the desktop app's
 * download link, then pairs through today's QR and consent flow. The link
 * carries no pairing offer; the computer mints one once muxr runs there.
 */
export function AddComputerScreen() {
    const styles = stylesheet;
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const compact = useCompactWindow();
    const link = addComputerLink();
    const shown = link?.replace(/^https:\/\//, '');
    const [notice, setNotice] = React.useState<string | undefined>();
    const [qrSide, setQrSide] = React.useState(0);
    const processPairLink = useHostedPairing();
    const canScan = usePairQrScannerAvailable();
    const scanPairQr = usePairQrScanner(processPairLink, canScan);

    const copy = React.useCallback(() => {
        if (link === undefined) return;
        void Clipboard.setStringAsync(link).then((ok) => {
            setNotice(ok === false ? 'Couldn’t copy. Type the link above into the computer’s browser.' : 'Link copied.');
        }, () => setNotice('Couldn’t copy. Type the link above into the computer’s browser.'));
    }, [link]);
    const share = React.useCallback(() => {
        if (link === undefined) return;
        setNotice(undefined);
        // Android's sheet takes a message, iOS a url.
        void Share.share(Platform.OS === 'android' ? { message: link } : { url: link }).catch(() => {
            setNotice('Couldn’t open sharing. Copy the link instead.');
        });
    }, [link]);

    return (
        <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.section}>
                <Text style={styles.lede}>Install the muxr app on your computer, then pair it with this {pairingDeviceNoun()}. No terminal needed.</Text>
                <Step number={1} title="On your computer, open this link">
                    {link === undefined || shown === undefined ? (
                        <Text style={styles.hint}>This app can’t hand over the download link. On your computer, install muxr from a terminal and run muxr instead.</Text>
                    ) : (
                        <>
                            <View style={styles.qrRow} onLayout={(event) => setQrSide(Math.min(200, Math.floor(event.nativeEvent.layout.width)))}>
                                {qrSide > 0 && <LinkQr text={link} size={qrSide} />}
                            </View>
                            <WordWrappingText selectable style={styles.link} fontSize={17} lineHeight={23}>{shown}</WordWrappingText>
                            <View style={[styles.actions, compact && styles.actionsCompact]}>
                                <View style={[styles.action, !compact && styles.actionInRow]}><ActionButton variant="secondary" title="Copy link" icon={compact ? undefined : 'copy-outline'} wrap onPress={copy} /></View>
                                <View style={[styles.action, !compact && styles.actionInRow]}><ActionButton variant="secondary" title="Share link" icon={compact ? undefined : 'share-outline'} wrap onPress={share} /></View>
                            </View>
                            {notice !== undefined && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
                            <Text style={styles.hint}>Type it into the computer’s browser, send it to yourself, or scan the QR from the computer.</Text>
                        </>
                    )}
                </Step>
                <Step number={2} title="Install and open muxr there">
                    <Text style={styles.hint}>The page has the download. Once muxr opens, it shows a QR on the computer’s screen.</Text>
                </Step>
                <Step number={3} title="Pair with the computer">
                    {canScan ? (
                        <ActionButton title="Scan the computer’s QR" icon={compact ? undefined : 'qr-code-outline'} wrap onPress={() => { void scanPairQr(); }} />
                    ) : (
                        <ActionButton title="Enter its pairing code" icon={compact ? undefined : 'keypad-outline'} wrap onPress={() => router.push('/pair?source=settings')} />
                    )}
                    <Text style={styles.hint}>You’ll check that the same two words show on both, then approve on the computer.</Text>
                </Step>
            </View>
        </ScrollView>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    section: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: 380,
        gap: 14,
    },
    lede: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
    card: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 14,
        gap: 10,
    },
    stepHead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    stepNumber: {
        minWidth: 26,
        minHeight: 26,
        paddingHorizontal: 6,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accentSubtle,
    },
    stepNumberText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
    },
    stepTitle: {
        ...Typography.default('semiBold'),
        flex: 1,
        fontSize: 16,
        lineHeight: 21,
        color: theme.colors.text,
    },
    qrRow: {
        alignSelf: 'stretch',
        alignItems: 'center',
    },
    qr: {
        borderRadius: 8,
        overflow: 'hidden',
    },
    link: {
        ...Typography.default('semiBold'),
        textAlign: 'center',
        color: theme.colors.text,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
    },
    actionsCompact: {
        flexDirection: 'column',
    },
    action: {
        flexGrow: 1,
        flexShrink: 1,
    },
    actionInRow: {
        flexBasis: 0,
    },
    notice: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
    },
    hint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
}));
