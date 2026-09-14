import * as React from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { useMachine, useSocketStatus } from '@/catalog/store';
import { syncReconnect } from '@/catalog/sync';
import {
    getCachedConnectionSettings,
    loadConnectionSettingsAsync,
    saveConnectionSettings,
    type SshTarget,
} from '@/connection';
import {
    forgetSshCredential,
    hasSshCredential,
    saveSshCredential,
    sshTunnelAvailable,
    stopSshTunnel,
    type SshCredential,
} from '@/connection/application/sshTunnel';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Stack } from 'expo-router';
import { getCachedHostedGrant } from '@/pairing/e2ee';
import { ConnectionSupport } from '@/settings/presentation/ConnectionSupport';
import { formatLatestConnectionFailure } from '@/catalog/infrastructure/connectionDiagnostics';

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
    multilineInput: { minHeight: 110 },
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
    multiline?: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{props.label}</Text>
            <TextInput
                style={[styles.input, props.multiline && styles.multilineInput]}
                value={props.value}
                onChangeText={props.onChange}
                placeholder={props.placeholder}
                placeholderTextColor={theme.colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                multiline={props.multiline}
                numberOfLines={props.multiline ? 5 : 1}
                textAlignVertical={props.multiline ? 'top' : 'center'}
                secureTextEntry={props.secure === true && props.multiline !== true}
                accessibilityLabel={props.label}
            />
        </View>
    );
}

function portValue(raw: string, fallback: number): number | undefined {
    const value = raw.trim();
    if (value === '') return fallback;
    if (!/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function sameSshEndpoint(left: SshTarget | undefined, right: SshTarget): boolean {
    return left?.host === right.host && left.port === right.port && left.username === right.username && left.relayPort === right.relayPort;
}

export default function ConnectionSettingsScreen() {
    const styles = stylesheet;
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
    const latestFailure = status === 'disconnected' || status === 'error'
        ? formatLatestConnectionFailure()
        : undefined;

    const [relayUrl, setRelayUrl] = React.useState(initial.relayUrl);
    const [machineId, setMachineId] = React.useState(initial.machineId);
    const [token, setToken] = React.useState(initial.token);
    const [sshHost, setSshHost] = React.useState(initial.ssh?.host ?? '');
    const [sshPort, setSshPort] = React.useState(String(initial.ssh?.port ?? 22));
    const [sshRelayPort, setSshRelayPort] = React.useState(String(initial.ssh?.relayPort ?? 8792));
    const [sshUsername, setSshUsername] = React.useState(initial.ssh?.username ?? '');
    const [sshPassword, setSshPassword] = React.useState('');
    const [sshPrivateKey, setSshPrivateKey] = React.useState('');
    const [sshPassphrase, setSshPassphrase] = React.useState('');
    const [sshCredentialPresent, setSshCredentialPresent] = React.useState(false);
    const [sshError, setSshError] = React.useState<string | undefined>(undefined);
    const [sshSaving, setSshSaving] = React.useState(false);
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
            setSshHost(loaded.ssh?.host ?? '');
            setSshPort(String(loaded.ssh?.port ?? 22));
            setSshRelayPort(String(loaded.ssh?.relayPort ?? 8792));
            setSshUsername(loaded.ssh?.username ?? '');
        });
        return () => { cancelled = true; };
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'android' || initial.machineId === '') {
            setSshCredentialPresent(false);
            return undefined;
        }
        let cancelled = false;
        void hasSshCredential(initial.machineId).then((present) => {
            if (!cancelled) setSshCredentialPresent(present);
        });
        return () => { cancelled = true; };
    }, [initial.machineId]);

    const sshSupported = Platform.OS === 'android' && initial.selfhost === true && sshTunnelAvailable();

    const saveSsh = async () => {
        const host = sshHost.trim();
        const username = sshUsername.trim();
        const port = portValue(sshPort, 22);
        const relayPort = portValue(sshRelayPort, 8792);
        const password = sshPassword;
        const privateKey = sshPrivateKey;
        const passphrase = sshPassphrase;
        if (initial.selfhost !== true || initial.machineId === '') {
            setSshError('Pair this phone with a self-hosted machine before configuring Direct SSH.');
            return;
        }
        if (host === '' || username === '') {
            setSshError('Enter the SSH host and username from the machine you want to reach.');
            return;
        }
        if (port === undefined || relayPort === undefined) {
            setSshError('SSH and relay ports must be numbers from 1 to 65535.');
            return;
        }
        if (password !== '' && privateKey !== '') {
            setSshError('Choose one SSH login method: password or private key.');
            return;
        }
        if (passphrase !== '' && privateKey === '') {
            setSshError('Paste the private key before entering its passphrase.');
            return;
        }
        if (password === '' && privateKey === '' && !sshCredentialPresent) {
            setSshError('Enter an SSH password or private key. It is stored only in this device’s secure store.');
            return;
        }
        setSshError(undefined);
        setSshSaving(true);
        try {
            const nextTarget: SshTarget = {
                host,
                username,
                port,
                relayPort,
                ...(sameSshEndpoint(initial.ssh, { host, username, port, relayPort }) && initial.ssh?.hostKey !== undefined
                    ? { hostKey: initial.ssh.hostKey }
                    : {}),
            };
            const credential: SshCredential = {
                ...(privateKey === '' ? {} : { privateKey }),
                ...(passphrase === '' ? {} : { passphrase }),
                ...(password === '' ? {} : { password }),
            };
            if (Object.keys(credential).length > 0) {
                await saveSshCredential(initial.machineId, credential);
            }
            const next = { ...initial, ssh: nextTarget };
            await saveConnectionSettings(next);
            setInitial(next);
            setSshHost(host);
            setSshUsername(username);
            setSshPort(String(port));
            setSshRelayPort(String(relayPort));
            setSshPassword('');
            setSshPrivateKey('');
            setSshPassphrase('');
            setSshCredentialPresent(true);
            await syncReconnect();
        } catch (cause) {
            setSshError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSshSaving(false);
        }
    };

    const disableSsh = async () => {
        setSshError(undefined);
        await stopSshTunnel();
        const next = { ...initial, ssh: undefined };
        await saveConnectionSettings(next);
        setInitial(next);
        await syncReconnect();
    };

    const forgetSsh = async () => {
        await forgetSshCredential(initial.machineId);
        setSshCredentialPresent(false);
        setSshPassword('');
        setSshPrivateKey('');
        setSshPassphrase('');
    };

    if (initial.mode === 'hosted') {
        const transport = initial.ssh !== undefined
            ? 'Direct SSH tunnel + end-to-end encryption'
            : initial.relayUrl.startsWith('wss://')
                ? 'HTTPS/WSS transport + end-to-end encryption'
                : 'Trusted-network WS transport + end-to-end encryption';
        const browserGrant = Platform.OS === 'web' ? getCachedHostedGrant(initial.machineId) : undefined;
        const browserExpiresAt = browserGrant?.expiresAt;
        const browserRole = browserGrant?.authority === 'control' ? 'Control' : 'View only';
        const browserMinutes = browserExpiresAt === undefined ? undefined : Math.max(0, Math.ceil((browserExpiresAt - clock) / 60_000));
        return (
            <ItemList>
            <Stack.Screen options={{ title: 'Connection & updates' }} />
                <ItemGroup title="Status">
                    <Item
                        title={statusText}
                        subtitle={status === 'connected' ? 'Your machine is reachable from this device' : latestFailure ?? socketError ?? 'The app reconnects on its own when the machine is back'}
                        subtitleLines={0}
                        leftElement={<View style={[styles.dot, statusDot]} />}
                        loading={status === 'connecting'}
                    />
                    <Item title="Transport" subtitle={transport} subtitleLines={0} detail="Self-host" />
                    <Item title="Relay" subtitle={initial.relayUrl} subtitleLines={0} />
                    {Platform.OS === 'web' && <Item title="Browser access" subtitle={browserExpiresAt === undefined || browserMinutes === undefined
                        ? `${browserRole} · pair again every eight hours`
                        : `${browserRole} · expires in ${Math.floor(browserMinutes / 60)}h ${browserMinutes % 60}m · ${new Date(browserExpiresAt).toLocaleString()}`} />}
                </ItemGroup>

                <ConnectionSupport hostVersion={machine?.metadata?.muxrCliVersion} />

                <ItemGroup title="Connection actions" footer="Your connection is end-to-end encrypted. Manage or revoke this device from muxr on the host.">
                    <Item title="Reconnect now" subtitle="Drops the socket and dials again" onPress={() => void syncReconnect()} />
                </ItemGroup>

                {sshSupported && <ItemGroup
                    title="Direct SSH"
                    footer="Android native builds only. SSH forwards the host's loopback relay; pairing, device grants, and end-to-end encryption stay unchanged. PWA and iPhone use Tailscale or another supported relay."
                >
                    <Field label="SSH host" value={sshHost} onChange={setSshHost} placeholder="server.example.com or 192.168.1.20" />
                    <Field label="SSH username" value={sshUsername} onChange={setSshUsername} placeholder="your login on the machine" />
                    <Field label="SSH port" value={sshPort} onChange={setSshPort} placeholder="22" />
                    <Field label="Relay port on the host" value={sshRelayPort} onChange={setSshRelayPort} placeholder="8792" />
                    <Field label="SSH password (optional)" value={sshPassword} onChange={setSshPassword} placeholder={sshCredentialPresent ? 'Saved credential remains unchanged' : 'Password or private key'} secure />
                    <Field label="Private key (optional)" value={sshPrivateKey} onChange={setSshPrivateKey} placeholder={sshCredentialPresent ? 'Paste a new key to replace the saved credential' : 'Paste an OpenSSH private key'} secure multiline />
                    <Field label="Private key passphrase" value={sshPassphrase} onChange={setSshPassphrase} placeholder="Only if the key is encrypted" secure />
                    <Item
                        title="SSH host key"
                        subtitle={initial.ssh?.hostKey === undefined ? 'Pinned after the first successful connection' : 'Pinned on this device; a change fails closed'}
                        subtitleLines={0}
                    />
                    {sshError !== undefined && <Text accessibilityRole="alert" style={styles.error}>{sshError}</Text>}
                    <View style={styles.actions}>
                        <RoundButton
                            title={sshSaving ? 'Saving…' : initial.ssh === undefined ? 'Save and use SSH' : 'Save SSH settings'}
                            size="large"
                            loading={sshSaving}
                            onPress={() => void saveSsh()}
                        />
                    </View>
                    {initial.ssh !== undefined && <Item title="Use current relay route instead" subtitle="Stops the SSH tunnel and returns to the paired relay URL" onPress={() => void disableSsh()} />}
                    {sshCredentialPresent && <Item title="Forget saved SSH credentials" subtitle="Removes the password or private key from this device" destructive onPress={() => void forgetSsh()} />}
                </ItemGroup>}
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
            <Stack.Screen options={{ title: 'Connection & updates' }} />
            <ItemGroup title="Status">
                <Item
                    title={statusText}
                    subtitle="Development connection"
                    leftElement={<View style={[styles.dot, statusDot]} />}
                    loading={status === 'connecting'}
                />
            </ItemGroup>
            <ConnectionSupport hostVersion={machine?.metadata?.muxrCliVersion} />
            <ItemGroup title="Development relay" footer="Printed by `muxr up` on the machine running the agents. A phone must use that machine's LAN address, not 127.0.0.1.">
                <Field label="Relay URL" value={relayUrl} onChange={setRelayUrl} placeholder="ws://192.168.1.20:8792" />
                <Field label="Machine name" value={machineId} onChange={setMachineId} placeholder="devbox" />
                <Field label="Token" value={token} onChange={setToken} placeholder="required off loopback" secure />
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
