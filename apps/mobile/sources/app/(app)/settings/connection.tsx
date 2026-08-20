import * as React from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { useMachine, useSocketStatus } from '@/sync/storage';
import { syncReconnect } from '@/sync/sync';
import {
    getCachedConnectionSettings,
    loadConnectionSettingsAsync,
    saveConnectionSettings,
} from '@/state/connectionSettings';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { getCachedHostedGrant } from '@/state/hostedE2ee';
import { knownHostVersion, versionsMismatch } from '@/utils/versionStatus';

const stylesheet = StyleSheet.create((theme) => ({
    label: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 15,
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
        ...Typography.mono(),
    },
    field: { paddingHorizontal: 16, paddingVertical: 10 },
    hint: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    error: {
        paddingHorizontal: 16,
        paddingBottom: 8,
        fontSize: 13,
        color: theme.colors.textDestructive,
        ...Typography.default(),
    },
    actions: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24 },
    detailMismatch: { color: theme.colors.warning },
    dot: { width: 9, height: 9, borderRadius: 5 },
    dotOn: { backgroundColor: theme.colors.success },
    dotBusy: { backgroundColor: theme.colors.warning },
    dotOff: { backgroundColor: theme.colors.divider },
    dotBad: { backgroundColor: theme.colors.textDestructive },
}));

function Field(props: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    placeholder: string;
    secure?: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{props.label}</Text>
            <TextInput
                style={styles.input}
                value={props.value}
                onChangeText={props.onChange}
                placeholder={props.placeholder}
                placeholderTextColor={theme.colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={props.secure === true}
                accessibilityLabel={props.label}
            />
        </View>
    );
}

export default function ConnectionSettingsScreen() {
    const styles = stylesheet;
    const router = useRouter();
    const [initial, setInitial] = React.useState(() => getCachedConnectionSettings());
    const { status, error: socketError } = useSocketStatus();
    const [clock, setClock] = React.useState(Date.now());
    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        const timer = setInterval(() => setClock(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);
    const statusText = {
        connected: t('status.connected'),
        connecting: t('status.connecting'),
        disconnected: t('status.disconnected'),
        error: t('status.error'),
    }[status];
    const statusDot = status === 'connected' ? styles.dotOn
        : status === 'connecting' ? styles.dotBusy
            : status === 'error' ? styles.dotBad : styles.dotOff;

    const [relayUrl, setRelayUrl] = React.useState(initial.relayUrl);
    const [machineId, setMachineId] = React.useState(initial.machineId);
    const [token, setToken] = React.useState(initial.token);
    const [encryptionKey, setEncryptionKey] = React.useState(initial.encryptionKey);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const [saving, setSaving] = React.useState(false);
    const machine = useMachine(initial.machineId);

    // getCachedConnectionSettings returns build-time defaults until storage has
    // hydrated. Opening this screen before that and pressing Save wrote those
    // defaults over a working config, and stored settings win forever after.
    React.useEffect(() => {
        let cancelled = false;
        void loadConnectionSettingsAsync().then((loaded) => {
            if (cancelled) return;
            setInitial(loaded);
            setRelayUrl(loaded.relayUrl);
            setMachineId(loaded.machineId);
            setToken(loaded.token);
            setEncryptionKey(loaded.encryptionKey);
        });
        return () => { cancelled = true; };
    }, []);

    if (initial.mode === 'hosted') {
        const transport = initial.relayUrl.startsWith('wss://')
            ? 'HTTPS/WSS transport + end-to-end encryption'
            : 'Trusted-network WS transport + end-to-end encryption';
        // Diagnostic only: a mismatch never blocks anything, it answers "is my
        // host older than my app?" without a debugging session.
        const appVersion = Constants.expoConfig?.version || '0.0.0';
        const reportedHost = machine?.metadata?.happyCliVersion;
        const hostVersion = knownHostVersion(reportedHost);
        const mismatch = versionsMismatch(appVersion, reportedHost);
        const browserExpiresAt = Platform.OS === 'web' ? getCachedHostedGrant(initial.machineId)?.expiresAt : undefined;
        const browserMinutes = browserExpiresAt === undefined ? undefined : Math.max(0, Math.ceil((browserExpiresAt - clock) / 60_000));
        return (
            <ItemList>
                <ItemGroup title="Status">
                    <Item
                        title={statusText}
                        subtitle={status === 'connected' ? 'Your machine is reachable from this device' : socketError ?? 'The app reconnects on its own when the machine is back'}
                        leftElement={<View style={[styles.dot, statusDot]} />}
                        loading={status === 'connecting'}
                    />
                    <Item title="Transport" subtitle={transport} detail="Self-host" />
                    <Item title="Relay" subtitle={initial.relayUrl} subtitleLines={0} />
                    <Item
                        title="Versions"
                        subtitle={`app ${appVersion} · host ${hostVersion ?? 'unknown'}`}
                        {...(mismatch ? { detail: '⚠ mismatch', detailStyle: styles.detailMismatch } : {})}
                    />
                    {Platform.OS === 'web' && <Item title="Browser access" subtitle={browserExpiresAt === undefined || browserMinutes === undefined
                        ? 'Read-only · pair again every eight hours'
                        : `Read-only · expires in ${Math.floor(browserMinutes / 60)}h ${browserMinutes % 60}m · ${new Date(browserExpiresAt).toLocaleString()}`} />}
                </ItemGroup>

                <ItemGroup
                    title="You run the relay"
                    footer="Use your local network, Tailscale, or your own secure tunnel. Every product feature stays available in the open-source self-hosted stack."
                >
                    <Item
                        title="End-to-end encrypted"
                        subtitle="Terminal output, keystrokes and approvals are sealed to your machine key before they leave this phone"
                        subtitleLines={0}
                    />
                    <Item
                        title="Pairing holds the credentials"
                        subtitle="Keys and tokens come from the QR grant. There is nothing to type in, and no shared-key fallback."
                        subtitleLines={0}
                    />
                </ItemGroup>

                <ItemGroup title="Advanced">
                    <Item title="Reconnect now" subtitle="Drops the socket and dials again" onPress={() => void syncReconnect()} />
                    <Item title="Pair another machine" subtitle="Paste a fresh string from `muxr pair`, or open its pairing link" onPress={() => router.push('/pair')} />
                    <Text style={styles.hint}>
                        To stop this device reaching a machine, revoke it from the interactive muxr menu.
                    </Text>
                </ItemGroup>
            </ItemList>
        );
    }

    const save = async () => {
        const url = relayUrl.trim();
        // A bare host or an http:// URL is the mistake people make, and the
        // failure mode is a silent 20s request timeout rather than anything
        // that points at the cause.
        if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
            setError('Relay URL must start with ws:// or wss://');
            return;
        }
        if (machineId.trim().length === 0) {
            setError('Machine name is required — it must match the host exactly.');
            return;
        }
        setError(undefined);
        setSaving(true);
        try {
            await saveConnectionSettings({
                ...initial,
                relayUrl: url,
                machineId: machineId.trim(),
                token: token.trim(),
                encryptionKey: encryptionKey.trim(),
            });
            await syncReconnect();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    // Development harness only: a relay in dev mode still accepts these. Paired
    // machines never reach this branch, so the fields stay out of the normal UI.
    return (
        <ItemList>
            <ItemGroup title="Status">
                <Item
                    title={statusText}
                    subtitle="Development connection"
                    leftElement={<View style={[styles.dot, statusDot]} />}
                    loading={status === 'connecting'}
                />
            </ItemGroup>
            <ItemGroup title="Development relay" footer="Printed by `muxr up` on the machine running the agents. A phone must use that machine's LAN address, not 127.0.0.1.">
                <Field label="Relay URL" value={relayUrl} onChange={setRelayUrl} placeholder="ws://192.168.1.20:8792" />
                <Field label="Machine name" value={machineId} onChange={setMachineId} placeholder="devbox" />
                <Field label="Token" value={token} onChange={setToken} placeholder="required off loopback" secure />
                <Field label="Shared key" value={encryptionKey} onChange={setEncryptionKey} placeholder="only if E2EE is on" secure />
                {error !== undefined && <Text style={styles.error}>{error}</Text>}
                <View style={styles.actions}>
                    <RoundButton
                        title={saving ? 'Connecting…' : 'Save and connect'}
                        size="large"
                        loading={saving}
                        onPress={save}
                    />
                </View>
            </ItemGroup>
        </ItemList>
    );
}
