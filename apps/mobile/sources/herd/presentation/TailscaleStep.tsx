import * as React from 'react';
import { Linking, Platform, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ActionButton } from '@/components/ActionButton';
import { Modal } from '@/modal';
import { pairingDeviceNoun } from '@/pairing';
import { openExternalUrl } from '@/utils/openExternalUrl';

const PLAY_STORE_APP = 'market://details?id=com.tailscale.ipn';
const PLAY_STORE_WEB = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';
const APP_STORE = 'https://apps.apple.com/app/id1470499037';
const DOWNLOAD_PAGE = 'https://tailscale.com/download';
// The reference 270 dp phone (and the PWA at font 2.0, 135 css px).
const NARROW_WIDTH = 300;

// ponytail: always shown on first run; Android could skip it when com.tailscale.ipn
// is installed, but that needs a native PackageManager call plus a <queries> entry.
async function openTailscaleStore(): Promise<void> {
    try {
        if (Platform.OS === 'web') return await openExternalUrl(DOWNLOAD_PAGE);
        if (Platform.OS === 'ios') return await Linking.openURL(APP_STORE);
        // A device without the Play Store app has no market: handler; its web page still installs.
        await Linking.openURL(PLAY_STORE_APP).catch(() => openExternalUrl(PLAY_STORE_WEB));
    } catch (error) {
        Modal.alert('Could not open the store', `${error instanceof Error ? error.message : String(error)}\nSearch for Tailscale in your app store.`);
    }
}

/**
 * The one step before pairing your own computer: both ends need Tailscale,
 * which computer setup now recommends. "I have Tailscale" goes on to pairing.
 */
export function TailscaleStep(props: { onReady: () => void }) {
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    const device = Platform.OS === 'web' ? 'device' : pairingDeviceNoun();
    return (
        <View style={styles.section}>
            <View style={[styles.card, width < NARROW_WIDTH && styles.cardNarrow]}>
                <Text style={styles.title}>Start with Tailscale</Text>
                <Text style={styles.body}>{`You need the free Tailscale app on this ${device} and on your computer. Sign in to the same account on both.`}</Text>
                <View style={styles.actions}>
                    <ActionButton title="Get Tailscale" icon="download-outline" wrap action={openTailscaleStore} />
                    <ActionButton variant="secondary" title="I have Tailscale" wrap onPress={props.onReady} />
                </View>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: 360,
    },
    card: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        padding: 18,
        gap: 6,
    },
    // At 270 dp the 18 dp side padding leaves the button too narrow for "Tailscale" whole.
    cardNarrow: { paddingHorizontal: 6 },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        color: theme.colors.text,
    },
    body: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
    actions: {
        marginTop: 10,
        gap: 10,
    },
}));
