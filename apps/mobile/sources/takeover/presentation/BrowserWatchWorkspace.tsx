import * as React from 'react';
import { BackHandler, Keyboard, Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useSurfaceEntries, dismissSurfaceOffer } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { useDeviceAuthority } from '@/pairing';
import { TerminalRoute } from '@/terminal/ui';
import { HostBrowserView } from './HostBrowserView';

/** Keep the live agent route mounted while its browser is watched or controlled. */
export function BrowserWatchWorkspace({ id }: { id: string }): React.JSX.Element {
    const { theme } = useUnistyles();
    const window = useWindowDimensions();
    const [contentWidth, setContentWidth] = React.useState(window.width);
    const machineId = getCachedConnectionSettings().machineId;
    const { authority } = useDeviceAuthority();
    const entries = useSurfaceEntries(machineId, id);
    const browsers = entries.filter((entry) => entry.offer.kind === 'browser-session');
    const [selectedName, setSelectedName] = React.useState<string | null>(null);
    const selected = selectedName === null ? undefined : browsers.find((entry) => entry.name === selectedName);
    const offer = selected?.offer.kind === 'browser-session' ? selected.offer : undefined;
    const latest = browsers.reduce<typeof browsers[number] | undefined>((best, entry) =>
        best === undefined || entry.receivedAt > best.receivedAt ? entry : best, undefined);
    const wide = contentWidth >= 764;
    const back = React.useRef<(() => boolean) | null>(null);

    React.useEffect(() => {
        if (!wide || selectedName !== null) return;
        const beside = browsers.find((entry) => entry.offer.placement === 'beside');
        if (beside !== undefined && authority === 'control') setSelectedName(beside.name);
    }, [wide, selectedName, browsers, authority]);

    React.useEffect(() => {
        if (wide || offer === undefined) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (back.current?.() === true) return true;
            setSelectedName(null);
            return true;
        });
        return () => subscription.remove();
    }, [wide, offer]);

    const watch = (): void => {
        if (latest === undefined || authority !== 'control') return;
        Keyboard.dismiss();
        setSelectedName(latest.name);
    };
    const showingBrowser = offer !== undefined && authority === 'control';

    return (
        <View
            style={{ flex: 1, backgroundColor: theme.colors.surface }}
            onLayout={(event) => setContentWidth(event.nativeEvent.layout.width)}
        >
            {latest !== undefined && !showingBrowser && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={authority === 'control' ? `Watch ${latest.name}` : 'Browser Watch needs a Control pairing'}
                    accessibilityState={{ disabled: authority !== 'control' }}
                    disabled={authority !== 'control'}
                    onPress={watch}
                    style={({ pressed }) => ({
                        minHeight: 48,
                        paddingHorizontal: 16,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        backgroundColor: theme.colors.surfaceHigh,
                        opacity: pressed ? 0.7 : 1,
                    })}
                >
                    <Ionicons name="eye-outline" size={18} color={theme.colors.text} />
                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 14 }}>
                        {authority === 'control' ? `Watch ${latest.name}` : 'Browser Watch needs a Control pairing'}
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            )}
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <View
                    pointerEvents={!wide && showingBrowser ? 'none' : 'auto'}
                    accessibilityElementsHidden={!wide && showingBrowser}
                    importantForAccessibility={!wide && showingBrowser ? 'no-hide-descendants' : 'auto'}
                    style={!wide && showingBrowser
                        ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 }
                        : { flex: 1 }}
                >
                    <TerminalRoute id={id} />
                </View>
                {showingBrowser && offer !== undefined && (
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <HostBrowserView
                            key={`${machineId}:${offer.session}`}
                            offer={offer}
                            machineId={machineId}
                            registerBackHandler={(handler) => { back.current = handler; }}
                            onReturnToAgent={() => setSelectedName(null)}
                            onClose={() => {
                                if (selected !== undefined) dismissSurfaceOffer(selected.handle);
                                setSelectedName(null);
                            }}
                        />
                    </View>
                )}
            </View>
        </View>
    );
}
