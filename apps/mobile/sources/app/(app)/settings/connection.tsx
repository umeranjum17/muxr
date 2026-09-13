import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Platform, View } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Field } from '@/components/Field';
import { SegmentedControl } from '@/components/SegmentedControl';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import { useMachine, usePairingFailure, useSocketStatus } from '@/catalog/store';
import { syncReconnect } from '@/catalog/sync';
import {
    getCachedConnectionSettings,
    loadConnectionSettingsAsync,
    pairingTransport,
    saveConnectionSettings,
} from '@/connection';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Stack, useRouter } from 'expo-router';
import { getCachedHostedGrant } from '@/pairing/e2ee';
import { ConnectionSupport } from '@/settings/presentation/ConnectionSupport';
import { formatLatestConnectionFailure } from '@/catalog/infrastructure/connectionDiagnostics';

const stylesheet = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', gap: 10, paddingHorizontal: 16 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    dotOn: { backgroundColor: theme.colors.success },
    dotBusy: { backgroundColor: theme.colors.warning },
    dotOff: { backgroundColor: theme.colors.divider },
    dotBad: { backgroundColor: theme.colors.textDestructive },
}));

const TRANSPORTS = [{ key: 'ws', label: 'ws' }, { key: 'wss', label: 'wss' }] as const;

/** The relay URL as the form holds it: scheme, host and port apart. */
function splitRelayUrl(relayUrl: string): { scheme: 'ws' | 'wss'; host: string; port: string } {
    try {
        const url = new URL(relayUrl);
        return { scheme: url.protocol === 'wss:' ? 'wss' : 'ws', host: url.hostname, port: url.port };
    } catch {
        return { scheme: 'ws', host: '', port: '' };
    }
}

export default function ConnectionSettingsScreen() {
    const styles = stylesheet;
    const router = useRouter();
    const [initial, setInitial] = React.useState(() => getCachedConnectionSettings());
    const { status, error: socketError } = useSocketStatus();
    // An expired or revoked grant is not a network problem: it needs a fresh
    // pairing, so the status row offers exactly that instead of reconnecting.
    const pairingFailure = usePairingFailure();
    const pairAgainReason = pairingFailure === 'grant-expired' ? 'expired' : pairingFailure === 'device-revoked' ? 'revoked' : undefined;
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
    const [restartCopied, setRestartCopied] = React.useState(false);
    const [urlCopied, setUrlCopied] = React.useState(false);

    const { theme } = useUnistyles();
    const [scheme, setScheme] = React.useState<'ws' | 'wss'>(() => splitRelayUrl(initial.relayUrl).scheme);
    const [host, setHost] = React.useState(() => splitRelayUrl(initial.relayUrl).host);
    const [port, setPort] = React.useState(() => splitRelayUrl(initial.relayUrl).port);
    const [machineId, setMachineId] = React.useState(initial.machineId);
    const [token, setToken] = React.useState(initial.token);
    const [error, setError] = React.useState<{ field: 'host' | 'port' | 'machine' | 'token'; text: string } | undefined>(undefined);
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
            const parts = splitRelayUrl(loaded.relayUrl);
            setScheme(parts.scheme);
            setHost(parts.host);
            setPort(parts.port);
            setMachineId(loaded.machineId);
            setToken(loaded.token);
        });
        return () => { cancelled = true; };
    }, []);

    if (initial.mode === 'hosted') {
        const route = pairingTransport(initial.relayUrl) ?? 'Relay';
        const secure = initial.relayUrl.startsWith('wss://');
        const browserGrant = Platform.OS === 'web' ? getCachedHostedGrant(initial.machineId) : undefined;
        const browserExpiresAt = browserGrant?.expiresAt;
        const browserRole = browserGrant?.authority === 'control' ? 'Control' : 'View only';
        const browserMinutes = browserExpiresAt === undefined ? undefined : Math.max(0, Math.ceil((browserExpiresAt - clock) / 60_000));
        return (
            <ItemList>
                <ItemGroup title="Status">
                    <Item
                        title={statusText}
                        subtitle={status === 'connected' ? 'Your machine is reachable from this device' : latestFailure ?? socketError ?? 'The app reconnects on its own when the machine is back'}
                        subtitleLines={0}
                        leftElement={<View style={[styles.dot, statusDot]} />}
                        loading={status === 'connecting'}
                    />
                    {pairAgainReason !== undefined && (
                        <Item
                            title="Pair again"
                            subtitle={pairAgainReason === 'expired'
                                ? 'This grant expired — claim a fresh link to reconnect'
                                : 'This device was revoked — claim a fresh link to reconnect'}
                            onPress={() => router.push(`/pair?source=settings&reason=${pairAgainReason}` as never)}
                        />
                    )}
                    {latestFailure !== undefined && pairAgainReason === undefined && (
                        <Item
                            title="If it stays offline"
                            subtitle="Check this device's connection and that the computer is awake. If muxr runs as a background service there, copy and run muxr restart; if you started it in a terminal, restart it there."
                            subtitleLines={0}
                            detail={restartCopied ? 'Copied' : 'Copy muxr restart'}
                            showChevron={false}
                            onPress={() => void Clipboard.setStringAsync('muxr restart').then((ok) => {
                                if (ok === false) return;
                                setRestartCopied(true);
                                setTimeout(() => setRestartCopied(false), 2000);
                            }).catch(() => {})}
                        />
                    )}
                </ItemGroup>

                <ItemGroup title="This computer" footer="Route, port and relay URL are connectionMode, relayPort and relayUrl in selfhost.json on the computer. Change them with muxr setup there: each restarts the relay and host, and a new relay URL means pairing every device again. This app cannot change them.">
                    <Item title="Route" subtitle={`${secure ? 'HTTPS/WSS' : 'WS'}, end-to-end encrypted either way. Inferred from the relay URL.`} subtitleLines={0} detail={route} />
                    <Item title="Relay URL" subtitle={initial.relayUrl} subtitleLines={0} mono showChevron={false} detail={urlCopied ? 'Copied' : 'Copy'}
                        onPress={() => void Clipboard.setStringAsync(initial.relayUrl).then((ok) => {
                            if (ok === false) return;
                            setUrlCopied(true);
                            setTimeout(() => setUrlCopied(false), 2000);
                        }).catch(() => {})} accessibilityLabel="Relay URL, tap to copy" />
                    {Platform.OS === 'web' && <Item title="Browser access" detail={browserRole} subtitle={browserExpiresAt === undefined || browserMinutes === undefined
                        ? 'Pair again when it expires'
                        : `Expires in ${Math.floor(browserMinutes / 60)}h ${browserMinutes % 60}m. Pair again after that.`} />}
                </ItemGroup>

                <ConnectionSupport hostVersion={machine?.metadata?.muxrCliVersion} />

                <ItemGroup title="Connection actions" footer="To stop this device reaching a computer, revoke it from the interactive muxr menu on that computer.">
                    <Item title="Reconnect now" subtitle="Drops the socket and dials again" onPress={() => void syncReconnect()} />
                    <Item title="Pair another machine" subtitle={Platform.OS === 'web' ? 'Paste the link printed by muxr pair --browser' : 'Scan the QR or enter the short string from muxr pair'} onPress={() => router.push('/pair?source=settings')} />
                </ItemGroup>
            </ItemList>
        );
    }

    const relayUrl = `${scheme}://${host.trim()}${port.trim() === '' ? '' : `:${port.trim()}`}`;
    const dirty = relayUrl !== initial.relayUrl || machineId.trim() !== initial.machineId || token.trim() !== initial.token;

    const save = async () => {
        if (host.trim() === '') { setError({ field: 'host', text: 'Host is required.' }); return; }
        const portNumber = Number(port.trim());
        if (port.trim() !== '' && (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535)) { setError({ field: 'port', text: 'Port is 1024 to 65535.' }); return; }
        if (machineId.trim() === '') { setError({ field: 'machine', text: 'Machine name is required; it must match the computer exactly.' }); return; }
        setError(undefined);
        setSaving(true);
        try {
            await saveConnectionSettings({
                ...initial,
                relayUrl,
                machineId: machineId.trim(),
                token: token.trim(),
            });
            await syncReconnect();
            router.back();
        } catch (e) {
            setError({ field: 'host', text: e instanceof Error ? e.message : String(e) });
        } finally {
            setSaving(false);
        }
    };
    const cancel = () => {
        if (!dirty) { router.back(); return; }
        void Modal.confirm('Discard changes?', 'The relay settings on this device stay as they were.', { cancelText: 'Keep editing', confirmText: 'Discard', destructive: true })
            .then((discard) => { if (discard) router.back(); });
    };

    // Development harness only: a relay in dev mode still accepts these. Paired
    // machines never reach this branch, so the fields stay out of the normal UI.
    // The screen holds a draft that one action commits, so its header is the
    // staged pair: cancel on the left, the confirm tick on the right.
    return (
        <ItemList>
            <Stack.Screen options={{
                headerTitle: 'Development relay',
                headerBackVisible: false,
                headerLeft: () => <HeaderBackButton icon="close" label="Cancel" onPress={cancel} />,
                headerRight: () => saving
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                    : <HeaderBackButton icon="checkmark" size={26} label="Save and connect" color={theme.colors.formAccent} disabled={!dirty} onPress={() => void save()} style={{ marginLeft: 0, marginRight: -8 }} />,
            }} />
            <ItemGroup title="Status">
                <Item
                    title={statusText}
                    subtitle="Development connection"
                    leftElement={<View style={[styles.dot, statusDot]} />}
                    loading={status === 'connecting'}
                />
            </ItemGroup>
            <ConnectionSupport hostVersion={machine?.metadata?.muxrCliVersion} />
            <ItemGroup title="Development relay" footer="Printed by muxr up on the computer running the agents. Saved on this device; confirming reconnects the app and changes nothing on the computer.">
                <Field label="Transport" helper="ws is for a trusted network; wss is required for a browser or a public route.">
                    <SegmentedControl accessibilityLabel="Transport" options={TRANSPORTS} value={scheme} onChange={setScheme} style={{ marginHorizontal: 0, marginVertical: 0 }} />
                </Field>
                <View style={styles.row}>
                    <Field label="Host" style={{ flex: 3, paddingHorizontal: 0 }} value={host} onChangeText={setHost} placeholder="The computer's LAN address, not 127.0.0.1" keyboardType="url"
                        error={error?.field === 'host' ? error.text : undefined} />
                    <Field label="Port" style={{ flex: 1, paddingHorizontal: 0 }} value={port} onChangeText={setPort} placeholder="8792" keyboardType="number-pad"
                        error={error?.field === 'port' ? error.text : undefined} />
                </View>
                <Field label="Machine name" value={machineId} onChangeText={setMachineId} placeholder="Exactly as the computer reports it"
                    error={error?.field === 'machine' ? error.text : undefined} />
                <Field label="Token" optional icon="key-outline" value={token} onChangeText={setToken} placeholder="Account token the relay issued" secureTextEntry
                    helper="A relay off 127.0.0.1 refuses an empty token."
                    error={error?.field === 'token' ? error.text : undefined} />
            </ItemGroup>
        </ItemList>
    );
}
