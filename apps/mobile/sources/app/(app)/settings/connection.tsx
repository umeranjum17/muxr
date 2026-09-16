import * as React from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { useMachine, useSocketStatus } from '@/catalog/store';
import { sync, syncReconnect } from '@/catalog/sync';
import {
    getCachedConnectionSettings,
    loadConnectionSettingsAsync,
    pairingTransport,
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
} from '@/connection';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Stack } from 'expo-router';
import { getCachedHostedGrant, loadHostedGrant, type StoredHostedGrant } from '@/pairing/e2ee';
import { retryRelayDiscovery, useRelayDiscoveryPhase } from '@/pairing';
import { Modal } from '@/modal';
import { ConnectionSupport } from '@/settings';
import { SshHostScan } from '@/settings/SshHostScan';
import { formatLatestConnectionFailure, latestFailureIsDeadGrant } from '@/catalog/diagnostics';
import { sshPublicKeyFromPrivate, type SshPublicKeyInfo } from '@/connection/sshPublicKey';

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

const routeNames: Record<string, string> = {
    tailscale: 'Tailscale Serve',
    'tailscale-direct': 'Direct Tailscale',
    private: 'Private network',
    lan: 'Same Wi-Fi',
    cloudflare: 'Temporary Cloudflare tunnel',
    external: 'Your own server',
    remote: 'Shared remote relay',
};

const routeDetails: Record<string, string> = {
    tailscale: 'For reaching this computer from anywhere: private HTTPS through Tailscale Serve; the phone joins the same tailnet.',
    'tailscale-direct': 'For reaching this computer from anywhere without Serve: direct tailnet address; the phone joins the same tailnet. Native app only.',
    private: 'For machines already on one private overlay network: the phone joins the same private network. Native app only.',
    lan: 'For phone and computer sharing one trusted Wi-Fi: stops working away from it. Native app only.',
    cloudflare: 'For a quick public route without your own server: public HTTPS through a temporary tunnel; its URL can change after restart.',
    external: 'For an existing relay you already run: a WSS relay or reverse proxy managed by the host owner.',
    remote: 'For a computer joining a relay managed elsewhere: this machine dials out to it.',
};

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
    const [settingsLoaded, setSettingsLoaded] = React.useState(false);
    const [hostRefresh, setHostRefresh] = React.useState<'loading' | 'ready' | 'failed'>('loading');
    const [grantRefresh, setGrantRefresh] = React.useState<'loading' | 'ready' | 'failed'>('loading');
    const [grant, setGrant] = React.useState<StoredHostedGrant | undefined>();
    const { status, error: socketError } = useSocketStatus();
    const nearbyPhase = useRelayDiscoveryPhase();
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
    // The one public command that restarts a background muxr, offered beside
    // a connection failure -- a network failure only: a dead grant needs
    // Pair again, not a restart.
    const [restartCopied, setRestartCopied] = React.useState(false);
    const offerRestart = latestFailure !== undefined && !latestFailureIsDeadGrant();
    React.useEffect(() => { if (!offerRestart) setRestartCopied(false); }, [offerRestart]);

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
    const [publicKeyCopied, setPublicKeyCopied] = React.useState(false);
    const [publicKeyInfo, setPublicKeyInfo] = React.useState<SshPublicKeyInfo>();
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
            setSettingsLoaded(true);
        });
        return () => { cancelled = true; };
    }, []);

    React.useEffect(() => {
        setPublicKeyCopied(false);
        let cancelled = false;
        void sshPublicKeyFromPrivate(sshPrivateKey).then((info) => {
            if (!cancelled) setPublicKeyInfo(info);
        });
        return () => { cancelled = true; };
    }, [sshPrivateKey]);

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

    React.useEffect(() => {
        if (!settingsLoaded || initial.mode !== 'hosted' || status !== 'connected') return undefined;
        let cancelled = false;
        let checking = false;
        const refresh = () => {
            if (checking) return;
            checking = true;
            setHostRefresh('loading');
            void sync.refreshMachines().then(() => {
                if (!cancelled) setHostRefresh('ready');
            }).catch(() => {
                if (!cancelled) setHostRefresh('failed');
            }).finally(() => { checking = false; });
        };
        refresh();
        const timer = setInterval(refresh, 30_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [settingsLoaded, initial.mode, initial.machineId, status]);

    React.useEffect(() => {
        if (!settingsLoaded || initial.mode !== 'hosted') return undefined;
        let cancelled = false;
        setGrantRefresh('loading');
        void loadHostedGrant(initial.machineId).then((loaded) => {
            if (cancelled) return;
            setGrant(loaded);
            setGrantRefresh('ready');
        }).catch(() => {
            if (!cancelled) setGrantRefresh('failed');
        });
        return () => { cancelled = true; };
    }, [settingsLoaded, initial.mode, initial.machineId]);

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
        const nearbyCopy: Record<typeof nearbyPhase, string> = {
            web: 'Browsers cannot scan nearby relays. If the computer’s address changed, run muxr setup there to refresh its route, then open a new browser pairing link.',
            disabled: 'Nearby scanning is off for this route. It runs only after pairing over a local or private address.',
            scanning: 'Looking for this paired computer on the local network. A new address must pass the saved device-grant check.',
            'no-service': 'No matching relay found nearby. Check that the computer and phone share Wi-Fi and muxr is running there, then retry.',
            found: 'A nearby advertisement claims this computer. A new address will be used only after its saved grant verifies.',
            verifying: 'Checking the nearby address against this device’s saved grant before changing the connection.',
            updated: 'Nearby address verified with this device’s saved grant. Reconnecting to the computer.',
            unverified: 'The nearby address could not be verified. The saved connection was kept; retry when the computer is reachable.',
            permission: 'Android blocked nearby discovery. Check this app’s network permission and Wi-Fi in system settings, then retry.',
            unavailable: 'Nearby discovery is unavailable in this app build. Refresh the route with muxr setup on the computer, then pair by QR or string if needed.',
            failed: 'Nearby discovery failed. Check Wi-Fi and retry; muxr setup on the computer can refresh its route if the address changed.',
        };
        const staleLanHint = status !== 'connected' && pairingTransport(initial.relayUrl) === 'Local or private network'
            ? ' The saved LAN address may have changed.' : '';
        const canRetryNearby = Platform.OS !== 'web' && !['disabled', 'unavailable'].includes(nearbyPhase);
        const transportPrivacy = initial.ssh !== undefined && sshSupported
            ? 'Direct SSH tunnel · end-to-end encrypted agent data'
            : `${initial.relayUrl.startsWith('wss://') ? 'TLS (WSS)' : 'WS without TLS'} transport · end-to-end encrypted agent data`;
        const currentGrant = grant?.machineId === initial.machineId ? grant : getCachedHostedGrant(initial.machineId);
        const browserGrant = Platform.OS === 'web' ? currentGrant : undefined;
        const browserExpiresAt = browserGrant?.expiresAt;
        const browserRole = browserGrant?.authority === 'control' ? 'Control' : 'View only';
        const mode = machine?.metadata?.connectionMode;
        const knownRoute = mode === undefined ? undefined : routeNames[mode];
        const route = knownRoute ?? pairingTransport(initial.relayUrl) ?? 'Unknown';
        const routeDetail = mode !== undefined && routeDetails[mode] !== undefined
            ? routeDetails[mode]
            : 'The host has not reported its selected route; this label is inferred from the relay address.';
        const pairedDeviceCount = status === 'connected' && hostRefresh === 'ready' ? machine?.metadata?.pairedDeviceCount : undefined;
        let pairedCountText: string;
        if (status !== 'connected') pairedCountText = 'Count unavailable while disconnected. Run muxr devices list on the computer.';
        else if (hostRefresh === 'loading') pairedCountText = 'Checking the host…';
        else if (hostRefresh === 'failed') pairedCountText = 'Could not refresh the count. Reconnect or run muxr devices list on the computer.';
        else if (pairedDeviceCount === undefined) pairedCountText = 'This host has not reported a count. Run muxr devices list on the computer.';
        else pairedCountText = `${pairedDeviceCount} paired at last check`;
        let statusSubtitle = latestFailure ?? socketError ?? 'The app reconnects on its own when the machine is back';
        if (status === 'connected') {
            if (hostRefresh === 'loading') statusSubtitle = 'Relay connected; checking the computer…';
            else if (hostRefresh === 'failed') statusSubtitle = 'Relay connected; the computer did not answer. Try Reconnect now or muxr doctor there.';
            else statusSubtitle = 'Relay connected; the computer answered the last check.';
        }
        let routeTitle = 'Route from relay address';
        if (knownRoute !== undefined) routeTitle = status === 'connected' && hostRefresh === 'ready' ? 'Current route' : 'Last reported route';
        let trust = 'No active device grant is available here. Pair again on the computer to restore access.';
        if (currentGrant !== undefined && !(Platform.OS === 'web' && browserExpiresAt !== undefined && browserExpiresAt <= clock)) {
            const role = Platform.OS === 'web' ? browserRole : currentGrant.authority === 'observe' ? 'View only' : 'Control';
            trust = `${role} access is bound to this device. The host requires its credential; agent data stays end-to-end encrypted.`;
        } else if (grantRefresh === 'loading') trust = 'Checking the saved device grant…';
        else if (grantRefresh === 'failed') trust = 'Could not read this device’s grant. Reopen the screen or pair again on the computer.';
        let browserAccess = 'No active browser grant. Pair again on the computer.';
        if (browserGrant !== undefined && browserExpiresAt !== undefined && browserExpiresAt > clock) {
            const minutes = Math.ceil((browserExpiresAt - clock) / 60_000);
            browserAccess = `${browserRole} · expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m · ${new Date(browserExpiresAt).toLocaleString()}`;
        } else if (browserGrant !== undefined && browserExpiresAt === undefined) browserAccess = `${browserRole} · pair again every eight hours`;
        else if (grantRefresh === 'loading') browserAccess = 'Checking the saved browser grant…';
        else if (grantRefresh === 'failed') browserAccess = 'Could not read the browser grant. Reopen the screen or pair again.';
        const changeRoute = async () => {
            try {
                await Clipboard.setStringAsync('muxr setup');
                Modal.alert('Command copied', 'Run muxr setup in the computer’s terminal to review and change its connection route.');
            } catch {
                Modal.alert('Copy failed', 'Run muxr setup in the computer’s terminal to review and change its connection route.');
            }
        };
        return (
            <ItemList>
                <Stack.Screen options={{ title: 'Connection & updates' }} />
                <ItemGroup title="Status">
                    <Item
                        title={statusText}
                        subtitle={statusSubtitle}
                        subtitleLines={0}
                        leftElement={<View style={[styles.dot, statusDot]} />}
                        loading={status === 'connecting'}
                    />
                    {offerRestart && <>
                        <Item title="Can't reach your computer" subtitle="Check this device's connection and that the computer is awake. If muxr was set up as a background service, run this on that computer:" subtitleLines={0} showChevron={false} />
                        <Item title="muxr restart" subtitle={restartCopied ? 'Copied' : 'Copy the command'} showChevron={false}
                            accessibilityLabel={restartCopied ? 'muxr restart, copied' : 'Copy muxr restart'}
                            onPress={() => { void Clipboard.setStringAsync('muxr restart').then(() => setRestartCopied(true)).catch(() => Modal.alert('Copy failed', 'Please try again.')); }} />
                        <Text style={styles.hint}>Otherwise, restart muxr from the terminal where you started it. Copying never runs anything on the computer.</Text>
                    </>}
                    <Item title={routeTitle} subtitle={`${route} · ${routeDetail}`} subtitleLines={0} />
                    <Item title="Transport & privacy" subtitle={transportPrivacy} subtitleLines={0} />
                    <Item title="Relay" subtitle={initial.relayUrl} subtitleLines={0} />
                    <Item title="Trust on this device" subtitle={trust} subtitleLines={0} />
                    <Item title="Paired phones & browsers" subtitle={pairedCountText} subtitleLines={0} />
                    {Platform.OS === 'web' && <Item title="Browser access" subtitle={browserAccess} subtitleLines={0} />}
                </ItemGroup>

                <ItemGroup title="Nearby reconnection" footer="Nearby discovery can locate only a computer already paired with this device. New devices still use a one-time QR or pairing string.">
                    <Item title="Discovery" subtitle={`${nearbyCopy[nearbyPhase]}${staleLanHint}`} subtitleLines={0} />
                    {canRetryNearby && <Item title="Retry nearby scan" subtitle="Search this Wi-Fi again" onPress={retryRelayDiscovery} />}
                </ItemGroup>

                <ConnectionSupport hostVersion={machine?.metadata?.muxrCliVersion} />

                <ItemGroup title="Connection actions" footer="The phone cannot change host networking. Manage or revoke devices with muxr devices on the computer.">
                    <Item title="Reconnect now" subtitle="Drops the socket and dials again" onPress={() => void syncReconnect()} />
                    {mode === 'remote'
                        ? <Item title="Change shared relay" subtitle="Ask the relay owner for a new enrollment, then run muxr connect --enrollment on this computer. The relay owner manages its route." subtitleLines={0} />
                        : knownRoute === undefined
                            ? <Item title="Change route on computer" subtitle="Run muxr setup for a self-hosted relay, or ask the relay owner for a new enrollment if it is shared. This device cannot change host networking." subtitleLines={0} />
                            : <Item title="Change route on computer" subtitle="Run muxr setup there to choose a route. If its address changes, remote devices may need a fresh pairing. Tap to copy the command." subtitleLines={0} onPress={() => void changeRoute()} />}
                </ItemGroup>

                {sshSupported && <ItemGroup
                    title="Direct SSH"
                    footer="Android native builds only. SSH forwards the host's loopback relay; pairing, device grants, and end-to-end encryption stay unchanged. PWA and iPhone use Tailscale or another supported relay."
                >
                    <Field label="SSH host" value={sshHost} onChange={(next) => { setSshHost(next); setPublicKeyCopied(false); }} placeholder="server.example.com or 192.168.1.20" />
                    <SshHostScan onPick={(host, port) => { setSshHost(host); if (port !== undefined && port !== 22) setSshPort(String(port)); }} />
                    <Field label="SSH username" value={sshUsername} onChange={setSshUsername} placeholder="your login on the machine" />
                    <Field label="SSH port" value={sshPort} onChange={setSshPort} placeholder="22" />
                    <Field label="Relay port on the host" value={sshRelayPort} onChange={setSshRelayPort} placeholder="8792" />
                    <Field label="SSH password (optional)" value={sshPassword} onChange={setSshPassword} placeholder={sshCredentialPresent ? 'Saved credential remains unchanged' : 'Password or private key'} secure />
                    <Field label="Private key (optional)" value={sshPrivateKey} onChange={(next) => { setSshPrivateKey(next); setPublicKeyCopied(false); }} placeholder={sshCredentialPresent ? 'Paste a new key to replace the saved credential' : 'Paste an OpenSSH private key'} secure multiline />
                    {publicKeyInfo !== undefined && <>
                        <Item
                            title="Key fingerprint"
                            subtitle={publicKeyInfo.algorithm === 'ssh-ed25519'
                                ? `${publicKeyInfo.algorithm} · ${publicKeyInfo.fingerprint} · this route needs RSA or ECDSA`
                                : `${publicKeyInfo.algorithm} · ${publicKeyInfo.fingerprint}`}
                            subtitleLines={0}
                            showChevron={false}
                        />
                        <Item
                            title="Copy public key"
                            subtitle={publicKeyCopied
                                ? 'Copied. Add it to ~/.ssh/authorized_keys on the machine.'
                                : 'The line to add to ~/.ssh/authorized_keys on the machine'}
                            onPress={() => {
                                void Clipboard.setStringAsync(publicKeyInfo.publicKey).then(() => setPublicKeyCopied(true)).catch(() => Modal.alert('Copy failed', 'Please try again.'));
                            }}
                            accessibilityLabel={publicKeyCopied ? 'Copy public key, copied' : 'Copy public key'}
                        />
                    </>}
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
