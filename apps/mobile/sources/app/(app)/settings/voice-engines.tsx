import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import type { VoiceProviderEntry } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { useSocketStatus } from '@/catalog/store';
import { startRealtimeCapability } from '@/conversation';
import { voiceProviderList, voiceProviderSet } from '@/conversation';

/**
 * Every engine installed on the connected machine, with the same explainer the
 * voice plugin used to render: what each one is, whether it is in use, and a way
 * to hear it.
 */
export default function VoiceEnginesScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { status } = useSocketStatus();
    const [providers, setProviders] = React.useState<VoiceProviderEntry[]>();
    const [busy, setBusy] = React.useState<string>();
    const [error, setError] = React.useState<string>();
    const busyRef = React.useRef(false);

    const load = React.useCallback(async () => {
        if (status !== 'connected') { setProviders([]); setError('Connect to a computer first.'); return; }
        try {
            setProviders((await voiceProviderList()).providers);
            setError(undefined);
        } catch (cause) {
            setProviders([]);
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [status]);

    React.useEffect(() => { void load(); }, [load]);

    const use = React.useCallback(async (provider: VoiceProviderEntry) => {
        if (provider.selected || busyRef.current) return;
        busyRef.current = true;
        setBusy(provider.id);
        try {
            setProviders((await voiceProviderSet(provider.id)).providers);
            setError(undefined);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            Modal.alert('Could not switch voice engine', message);
            await load();
        } finally {
            busyRef.current = false;
            setBusy(undefined);
        }
    }, [load]);

    if (providers === undefined) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{ minHeight: 56, alignItems: 'center', justifyContent: 'center' }}>
                        <ActivityIndicator />
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    const selected = providers.find((provider) => provider.selected);
    return (
        <ItemList>
            <ItemGroup
                title="Engines on this machine"
                footer={error ?? 'Each engine is a different voice on the connected machine. Open one to use it and talk to hear it.'}
            >
                {providers.length === 0 ? (
                    <Item title="No voice engines are available on this machine." showChevron={false} />
                ) : providers.map((provider) => (
                    <Item
                        key={provider.id}
                        title={provider.name}
                        subtitle={provider.description}
                        subtitleLines={2}
                        selected={provider.selected}
                        loading={busy === provider.id}
                        showChevron={false}
                        icon={<Ionicons name="mic-outline" size={28} color={theme.colors.textSecondary} />}
                        rightElement={provider.selected ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.textLink} /> : undefined}
                        accessibilityLabel={`${provider.name}${provider.selected ? ', in use' : ''}`}
                        onPress={() => { void use(provider); }}
                        onLongPress={() => router.push(`/settings/voice-provider?providerId=${encodeURIComponent(provider.id)}` as never)}
                    />
                ))}
            </ItemGroup>
            {selected !== undefined && (
                <ItemGroup footer="Talking starts a live session with the engine in use above.">
                    <Item
                        title={`Configure ${selected.name}`}
                        subtitle="Open this engine's settings on the connected machine"
                        icon={<Ionicons name="settings-outline" size={28} color={theme.colors.textSecondary} />}
                        showChevron={false}
                        onPress={() => router.push(`/settings/voice-provider?providerId=${encodeURIComponent(selected.id)}` as never)}
                    />
                    <Item
                        title="Talk now"
                        icon={<Ionicons name="chatbubbles-outline" size={28} color={theme.colors.textSecondary} />}
                        showChevron={false}
                        onPress={() => { void startRealtimeCapability(); }}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
