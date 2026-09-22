import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import type { VoiceProviderDescription, VoiceStatus } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { useSocketStatus } from '@/catalog/store';
import { voiceKeyClear, voiceKeySet, voiceProviderDescribe, voiceStatus } from '@/conversation';

/**
 * Setup for one realtime voice engine on the connected machine. Mirrors the
 * two surfaces the voice plugin used to render: an API-key store for the
 * hosted engines, and the ChatGPT-login note for Codex Voice.
 */
export default function VoiceProviderSetupScreen() {
    const { theme } = useUnistyles();
    const { status: socketStatus } = useSocketStatus();
    const params = useLocalSearchParams<{ providerId?: string }>();
    const providerId = typeof params.providerId === 'string' && params.providerId !== '' ? params.providerId : undefined;
    const [description, setDescription] = React.useState<VoiceProviderDescription>();
    const [status, setStatus] = React.useState<VoiceStatus>();
    const [busy, setBusy] = React.useState(false);
    const [loaded, setLoaded] = React.useState(false);
    const [error, setError] = React.useState<string>();

    const load = React.useCallback(async () => {
        if (socketStatus !== 'connected') { setLoaded(true); setError('Connect to a computer first.'); return; }
        setLoaded(false);
        try {
            const next = await voiceProviderDescribe(providerId);
            setDescription(next);
            setStatus(await voiceStatus().catch(() => undefined));
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoaded(true);
        }
    }, [providerId, socketStatus]);

    React.useEffect(() => { void load(); }, [load]);

    const setKey = React.useCallback(async () => {
        if (busy) return;
        const key = await Modal.prompt(
            'Realtime voice API key',
            'Sent once to this machine and stored only there.',
            { placeholder: 'Paste the key', inputType: 'secure-text', confirmText: 'Save' },
        );
        if (key === null || key.trim() === '') return;
        setBusy(true);
        try {
            await voiceKeySet(key.trim(), providerId);
            await load();
        } catch (cause) {
            Modal.alert('Could not save the key', cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    }, [busy, load, providerId]);

    const clearKey = React.useCallback(async () => {
        if (busy) return;
        if (!await Modal.confirm(
            'Clear the stored key?',
            'Realtime voice will stop until a new key is configured.',
            { confirmText: 'Clear', destructive: true },
        )) return;
        setBusy(true);
        try {
            await voiceKeyClear(providerId);
            await load();
        } catch (cause) {
            Modal.alert('Could not clear the key', cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    }, [busy, load, providerId]);

    if (!loaded) {
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

    const usesApiKey = description?.setup === 'api-key';
    return (
        <ItemList>
            <ItemGroup
                title={description?.name ?? 'Realtime voice'}
                footer={error ?? description?.description}
            >
                <Item title="Provider" detail={description?.name ?? status?.providerName ?? 'Unavailable'} showChevron={false} />
                <Item
                    title={usesApiKey ? 'Key' : 'Login'}
                    detail={description?.statusLabel ?? status?.statusLabel ?? 'Unknown'}
                    showChevron={false}
                />
            </ItemGroup>
            {usesApiKey ? (
                <ItemGroup footer="The key is sent directly to the connected machine and is never stored or displayed by the phone.">
                    <Item
                        title="Set or replace key"
                        icon={<Ionicons name="key-outline" size={28} color={theme.colors.textSecondary} />}
                        loading={busy}
                        showChevron={false}
                        onPress={() => { void setKey(); }}
                    />
                    <Item
                        title="Clear key"
                        destructive
                        icon={<Ionicons name="trash-outline" size={28} color={theme.colors.textSecondary} />}
                        showChevron={false}
                        onPress={() => { void clearKey(); }}
                    />
                </ItemGroup>
            ) : (
                <ItemGroup>
                    <Item
                        title="Run codex login with ChatGPT on this machine."
                        subtitle="No API key needed. Experimental realtime access depends on your account."
                        subtitleLines={0}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
