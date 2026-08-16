import React, { useState } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { useConnectAccount } from '@/hooks/useConnectAccount';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { loadAppConfig } from '@/sync/appConfig';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { directBillingUrl } from '@/commercialization';
import { relayControlUrl } from '@muxr/contract';

export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const { connectAccount, isLoading: isConnecting } = useConnectAccount();
    const connection = getCachedConnectionSettings();
    const hosted = connection.mode === 'hosted';
    const [devices, setDevices] = useState<Array<{ id: string; name: string; kind: string; current: boolean }>>([]);
    const [accountInfo, setAccountInfo] = useState<{ email?: string; entitlement?: string; plan?: string }>({});
    const appConfig = loadAppConfig();
    const billingUrl = directBillingUrl(appConfig);
    let apiBase: string | undefined;
    try {
        if (hosted) apiBase = relayControlUrl(connection.relayUrl);
    } catch {}
    const refreshDevices = React.useCallback(async () => {
        if (!hosted || apiBase === undefined || !auth.credentials?.token) return;
        const [devicesResponse, sessionResponse] = await Promise.all([
            fetch(`${apiBase}/v1/devices`, { headers: { authorization: `Bearer ${auth.credentials.token}` } }),
            fetch(`${apiBase}/v1/session`, { headers: { authorization: `Bearer ${auth.credentials.token}` } }),
        ]);
        if (devicesResponse.ok) {
            const body = await devicesResponse.json() as { devices?: Array<{ id: string; name: string; kind: string; current: boolean }> };
            setDevices(body.devices ?? []);
        }
        if (sessionResponse.ok) {
            const body = await sessionResponse.json() as { account?: { email?: string; entitlement?: string; plan?: string } };
            setAccountInfo(body.account ?? {});
        } else if (sessionResponse.status === 401) {
            // Confirm account rejection through the shared validator; machine/ticket
            // failures never log the account out.
            void sync.refreshAccountSession().catch(() => undefined);
        }
    }, [apiBase, auth.credentials?.token, hosted]);
    React.useEffect(() => { void refreshDevices(); }, [refreshDevices]);
    const revokeDevice = React.useCallback(async (device: { id: string; name: string }) => {
        if (apiBase === undefined || device.id === '' || !auth.credentials?.token) return;
        const confirmed = await Modal.confirm('Revoke this device?', `${device.name} will disconnect immediately. Affected machine keys rotate before more hosted traffic is accepted.`, { confirmText: 'Revoke', destructive: true });
        if (!confirmed) return;
        const response = await fetch(`${apiBase}/v1/devices/${encodeURIComponent(device.id)}/revoke`, {
            method: 'POST',
            headers: { authorization: `Bearer ${auth.credentials.token}`, 'content-type': 'application/json' },
            body: '{}',
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { error?: string };
            Modal.alert('Revocation failed', body.error ?? `Request failed (${response.status})`);
            return;
        }
        await refreshDevices();
    }, [apiBase, auth.credentials?.token, refreshDevices]);

    const deleteHostedAccount = React.useCallback(async () => {
        if (apiBase === undefined || !auth.credentials?.token) return;
        const confirmed = await Modal.confirm(
            'Delete your muxr account?',
            'This cancels the Stripe subscription, revokes every hosted machine, device, credential and key grant, and ends hosted access. Local herdr work stays on your computer.',
            { confirmText: 'Send code', destructive: true },
        );
        if (!confirmed) return;
        const started = await fetch(`${apiBase}/v1/account/deletion/start`, {
            method: 'POST',
            headers: { authorization: `Bearer ${auth.credentials.token}`, 'content-type': 'application/json' },
            body: '{}',
        });
        const startBody = await started.json().catch(() => ({})) as { deletion_id?: string; error?: string };
        if (!started.ok || !startBody.deletion_id) {
            Modal.alert('Deletion failed', startBody.error ?? `Request failed (${started.status})`);
            return;
        }
        const code = await Modal.prompt('Fresh email code', 'Enter the six-digit code to permanently delete the account.', { placeholder: '123456' });
        if (!code?.trim()) return;
        const response = await fetch(`${apiBase}/v1/account/deletion/confirm`, {
            method: 'POST',
            headers: { authorization: `Bearer ${auth.credentials.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ deletion_id: startBody.deletion_id, code: code.trim() }),
        });
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) {
            Modal.alert('Deletion failed', body.error ?? `Request failed (${response.status})`);
            return;
        }
        await auth.logout();
    }, [apiBase, auth]);

    // Get the current secret key
    const currentSecret = auth.credentials?.secret || '';
    const formattedSecret = currentSecret ? formatSecretKeyForBackup(currentSecret) : '';

    const handleShowSecret = () => {
        setShowSecret(!showSecret);
    };

    const handleCopySecret = async () => {
        try {
            await Clipboard.setStringAsync(formattedSecret);
            setCopiedRecently(true);
            setTimeout(() => setCopiedRecently(false), 2000);
            Modal.alert(t('common.success'), t('settingsAccount.secretKeyCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
        }
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true }
        );
        if (confirmed) {
            auth.logout();
        }
    };

    return (
        <>
            <ItemList>
                {/* Account Info */}
                <ItemGroup title={t('settingsAccount.accountInformation')}>
                    <Item
                        title={hosted ? 'Verified email' : t('settingsAccount.status')}
                        detail={hosted ? accountInfo.email ?? 'Verified' : auth.isAuthenticated ? t('settingsAccount.statusActive') : t('settingsAccount.statusNotAuthenticated')}
                        showChevron={false}
                    />
                    {hosted && <Item title="Hosted access" detail={`${accountInfo.entitlement ?? 'unknown'} · ${accountInfo.plan ?? 'none'}`} showChevron={false} />}
                    {hosted && billingUrl && (
                        <Item
                            title="Manage billing on the web"
                            subtitle="Direct APK distribution only"
                            icon={<Ionicons name="open-outline" size={29} color="#007AFF" />}
                            onPress={() => openExternalUrl(billingUrl)}
                        />
                    )}
                    {!hosted && <Item
                        title={t('settingsAccount.anonymousId')}
                        detail={sync.anonID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.anonID}
                    />}
                    {!hosted && <Item
                        title={t('settingsAccount.publicId')}
                        detail={sync.serverID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.serverID}
                    />}
                    {!hosted && Platform.OS !== 'web' && (
                        <Item
                            title={t('settingsAccount.linkNewDevice')}
                            subtitle={isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle')}
                            icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                            onPress={connectAccount}
                            disabled={isConnecting}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>

                {hosted && (
                    <ItemGroup title="Authorized devices" footer="Revoke a lost device here. Hosted access stops immediately; affected machines rotate before reconnecting.">
                        {devices.map((device) => (
                            <Item
                                key={device.id}
                                title={device.name || device.kind}
                                subtitle={device.current ? 'This device' : 'Tap to revoke'}
                                icon={<Ionicons name="phone-portrait-outline" size={29} color={device.current ? '#34C759' : '#FF3B30'} />}
                                destructive={!device.current}
                                disabled={device.current}
                                onPress={device.current ? undefined : () => { void revokeDevice(device); }}
                            />
                        ))}
                    </ItemGroup>
                )}

                {/* Legacy local-fixture backup only. Hosted device keys never leave SecureStore. */}
                {!hosted && <ItemGroup
                    title={t('settingsAccount.backup')}
                    footer={t('settingsAccount.backupDescription')}
                >
                    <Item
                        title={t('settingsAccount.secretKey')}
                        subtitle={showSecret ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                        icon={<Ionicons name={showSecret ? "eye-off-outline" : "eye-outline"} size={29} color="#FF9500" />}
                        onPress={handleShowSecret}
                        showChevron={false}
                    />
                </ItemGroup>}

                {/* Secret Key Display */}
                {!hosted && showSecret && (
                    <ItemGroup>
                        <Pressable onPress={handleCopySecret}>
                            <View style={{
                                backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.textSecondary,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('settingsAccount.secretKeyLabel')}
                                    </Text>
                                    <Ionicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? "#34C759" : theme.colors.textSecondary}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: theme.colors.text,
                                    ...Typography.mono()
                                }}>
                                    {formattedSecret}
                                </Text>
                            </View>
                        </Pressable>
                    </ItemGroup>
                )}

                {/* Danger Zone */}
                <ItemGroup title={t('settingsAccount.dangerZone')}>
                    <Item
                        title={t('settingsAccount.logout')}
                        subtitle={t('settingsAccount.logoutSubtitle')}
                        icon={<Ionicons name="log-out-outline" size={29} color="#FF3B30" />}
                        destructive
                        onPress={handleLogout}
                    />
                    {hosted && (
                        <Item
                            title="Delete account"
                            subtitle="Fresh email code required"
                            icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                            destructive
                            onPress={() => void deleteHostedAccount()}
                        />
                    )}
                </ItemGroup>
            </ItemList>
        </>
    );
});
