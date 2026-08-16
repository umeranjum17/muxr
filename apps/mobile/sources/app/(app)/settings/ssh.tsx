import * as React from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as SecureStore from 'expo-secure-store';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { closeSshTunnel, connectSshTunnel, forgetPinnedHostKey, getPinnedHostKey } from '../../../../modules/ssh-tunnel';
import { setActiveSshForward } from '@/state/sshForward';

const STORE_KEY = 'muxr.ssh.config';
const LOCAL_PORT = 8792;

interface SavedSsh {
    host: string;
    port: number;
    username: string;
}

function Field(props: {
    label: string;
    hint?: string;
    value: string;
    onChange: (next: string) => void;
    placeholder: string;
    secure?: boolean;
    numeric?: boolean;
    multiline?: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{props.label}</Text>
            <TextInput
                style={[styles.input, props.multiline === true && styles.inputMultiline]}
                value={props.value}
                onChangeText={props.onChange}
                placeholder={props.placeholder}
                placeholderTextColor={theme.colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={props.secure === true}
                keyboardType={props.numeric === true ? 'number-pad' : 'default'}
                multiline={props.multiline === true}
                accessibilityLabel={props.label}
            />
            {props.hint !== undefined && <Text style={styles.hint}>{props.hint}</Text>}
        </View>
    );
}

/** Settings → Connect over SSH: tunnel to a box's loopback relay, no relay URL needed. */
export default function SshSettingsScreen() {
    const [host, setHost] = React.useState('');
    const [port, setPort] = React.useState('22');
    const [username, setUsername] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [privateKey, setPrivateKey] = React.useState('');
    const [status, setStatus] = React.useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
    const [pinnedKey, setPinnedKey] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        void SecureStore.getItemAsync(STORE_KEY).then(async (raw) => {
            if (raw === null) return;
            const saved = JSON.parse(raw) as SavedSsh;
            setHost(saved.host);
            setPort(String(saved.port));
            setUsername(saved.username);
            setPinnedKey(await getPinnedHostKey(saved.host, saved.port));
        });
    }, []);

    const connect = async () => {
        if (host.trim() === '' || username.trim() === '') {
            Modal.alert('Missing details', 'Host and username are required.');
            return;
        }
        const numericPort = Number(port) || 22;
        const knownKey = await getPinnedHostKey(host, numericPort);
        if (knownKey === undefined) {
            // Honest first-use consent: the fingerprint is only observable after
            // the session is established, so the login really is sent to an
            // unverified server on this one connection.
            const accepted = await Modal.confirm(
                'First connection to this server',
                `This phone has never connected to ${host.trim()} before, so it will trust whichever host key the server presents — and your sign-in is sent during that same connection. Continue only if you trust this network right now.\n\nAfter this, the key is remembered and any change is refused before your sign-in is sent.`,
                { confirmText: 'Continue' },
            );
            if (!accepted) return;
        }
        setStatus('connecting');
        try {
            await SecureStore.setItemAsync(STORE_KEY, JSON.stringify({ host: host.trim(), port: numericPort, username: username.trim() }));
            const result = await connectSshTunnel(
                { host: host.trim(), port: numericPort, username: username.trim(), ...(password !== '' ? { password } : {}), ...(privateKey.trim() !== '' ? { privateKey: privateKey.trim() } : {}) },
                { localPort: LOCAL_PORT, remoteHost: '127.0.0.1', remotePort: LOCAL_PORT },
            );
            setActiveSshForward({ localPort: LOCAL_PORT });
            setStatus('connected');
            setPinnedKey(result.fingerprint);
            // Password and key live only in component state; only host/port/user persist.
            setPassword('');
            setPrivateKey('');
            Modal.alert(
                'Tunnel connected',
                result.pinned
                    ? 'The server presented the same host key as last time.\n\nPair with the string from `muxr self-host` to finish.'
                    : `Host key remembered for this server:\n${result.fingerprint}\n\nIf it ever changes, muxr refuses the connection before sending your sign-in.\n\nPair with the string from \`muxr self-host\` to finish.`,
            );
        } catch (error) {
            setStatus('disconnected');
            Modal.alert('SSH connection failed', error instanceof Error ? error.message : String(error));
        }
    };

    const disconnect = async () => {
        await closeSshTunnel();
        setActiveSshForward(undefined);
        setStatus('disconnected');
    };

    const forgetKey = async () => {
        const confirmed = await Modal.confirm(
            'Forget this host key?',
            'Do this only if you rebuilt or replaced the server yourself. The next connection will trust a new key without warning, exactly like a first connection.',
            { confirmText: 'Forget key', destructive: true },
        );
        if (!confirmed) return;
        await forgetPinnedHostKey(host, Number(port) || 22);
        setPinnedKey(undefined);
    };

    const connected = status === 'connected';
    const statusLabel = connected ? 'Tunnel active' : status === 'connecting' ? 'Connecting…' : 'Not connected';

    return (
        <ItemList>
            <ItemGroup
                title="Status"
                footer="For machines you already reach over SSH. muxr forwards this phone to the relay listening on the machine's own loopback, so nothing new is exposed to the network."
            >
                <Item
                    title={statusLabel}
                    subtitle={connected
                        ? `Relay reachable on this phone as ws://127.0.0.1:${LOCAL_PORT}`
                        : 'Fill in the server below, then connect'}
                    leftElement={<View style={[styles.dot, connected ? styles.dotOn : status === 'connecting' ? styles.dotBusy : styles.dotOff]} />}
                    loading={status === 'connecting'}
                />
            </ItemGroup>

            <ItemGroup title="Server">
                <Field label="Host" value={host} onChange={setHost} placeholder="devbox.local" />
                <Field label="Port" value={port} onChange={setPort} placeholder="22" numeric />
            </ItemGroup>

            <ItemGroup
                title="Authentication"
                footer="Your password and key are used once to open the tunnel and are never written to this phone. Only the host, port and username are remembered."
            >
                <Field label="Username" value={username} onChange={setUsername} placeholder="you" />
                <Field label="Password" value={password} onChange={setPassword} placeholder="••••••••" secure />
                <Field
                    label="Private key"
                    hint="Optional, instead of a password. Paste the key file as a single base64 line."
                    value={privateKey}
                    onChange={setPrivateKey}
                    placeholder="Base64 of the key file"
                    multiline
                />
            </ItemGroup>

            <ItemGroup
                title="Server identity"
                footer={pinnedKey === undefined
                    ? 'Nothing is remembered for this server yet. muxr can only see the key once a connection is established, so the first connection is the one you have to trust.'
                    : 'A different key on a later connection is refused before your sign-in is sent.'}
            >
                {pinnedKey === undefined ? (
                    <Item title="No key remembered yet" subtitle="The first connection will trust whatever the server presents" />
                ) : (
                    <>
                        <Item title="Remembered key" subtitle={pinnedKey} subtitleLines={0} subtitleStyle={styles.mono} />
                        <Item title="Forget this key" subtitle="Only after you rebuilt the server yourself" destructive onPress={() => void forgetKey()} />
                    </>
                )}
            </ItemGroup>

            <ItemGroup title="Relay forwarding" footer={`This phone's 127.0.0.1:${LOCAL_PORT} is forwarded to 127.0.0.1:${LOCAL_PORT} on the machine. End-to-end encryption still applies on top of the tunnel.`}>
                <Item
                    title={connected ? 'Disconnect' : 'Connect'}
                    subtitle={connected ? 'Closes the tunnel and stops forwarding' : 'Opens the tunnel and starts forwarding'}
                    loading={status === 'connecting'}
                    destructive={connected}
                    onPress={() => void (connected ? disconnect() : connect())}
                />
            </ItemGroup>
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    field: { paddingHorizontal: 16, paddingVertical: 8 },
    label: { ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.textSecondary, marginBottom: 6 },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
    },
    inputMultiline: { minHeight: 76, textAlignVertical: 'top' },
    hint: { ...Typography.default(), fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary, marginTop: 6 },
    mono: { ...Typography.mono(), fontSize: 12, lineHeight: 17 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    dotOn: { backgroundColor: theme.colors.success },
    dotBusy: { backgroundColor: theme.colors.warning },
    dotOff: { backgroundColor: theme.colors.divider },
}));
