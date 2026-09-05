import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useLocalSettingMutable } from '@/catalog/store';
import { formatConnectionDiagnosticsForReport } from '@/catalog/infrastructure/connectionDiagnostics';
import { loadAppConfig } from '@/catalog/infrastructure/appConfig';
import { getAppBuildNumber, getAppVersion } from '@/utils/appVersion';
import { knownHostVersion, versionsMismatch } from '@/utils/versionStatus';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { t } from '@/text';

/** One destination for installed versions, update guidance and connection evidence. */
export function ConnectionSupport({ hostVersion: reportedHost }: { hostVersion?: string }) {
    const { theme } = useUnistyles();
    const appVersion = getAppVersion();
    const build = getAppBuildNumber();
    const hostVersion = knownHostVersion(reportedHost);
    const mismatch = versionsMismatch(appVersion, hostVersion);
    const [details, setDetails] = React.useState<string>();
    const [copied, setCopied] = React.useState(false);
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const appConfig = loadAppConfig();
    const versionClick = useMultiClick(() => {
        setDevModeEnabled(!devModeEnabled);
        Modal.alert(t('modals.developerMode'), devModeEnabled ? t('modals.developerModeDisabled') : t('modals.developerModeEnabled'));
    }, { requiredClicks: 10, resetTimeout: 2000 });
    const diagnosticText = () => [
        `App ${appVersion}${build ? ` / build ${build}` : ''}; host ${hostVersion ?? 'unknown'}`,
        appConfig.buildCommitSha ? `App source ${appConfig.buildCommitSha.slice(0, 12)}` : undefined,
        formatConnectionDiagnosticsForReport(),
    ].filter(Boolean).join('\n');
    return <>
        <ItemGroup title="Installed versions">
            {mismatch && <View accessibilityRole="alert" style={{ margin: 16, padding: 16, borderRadius: 12, borderWidth: 2, borderColor: theme.colors.box.warning.border, backgroundColor: theme.colors.box.warning.background }}>
                <Text style={{ color: theme.colors.text, fontWeight: '700', fontSize: 17 }}>App and host versions differ</Text>
                <Text style={{ marginTop: 8, color: theme.colors.text, fontSize: 15, lineHeight: 22 }}>
                    App {appVersion} · host {hostVersion}. This does not by itself mean the connection is broken. If features behave differently, update the older component using the same release channel.
                </Text>
            </View>}
            <Item title={Platform.OS === 'web' ? 'Web app' : 'Installed app'} subtitle={`Version ${appVersion}${build ? ` · build ${build}` : ''}`}
                subtitleLines={0} onPress={versionClick} showChevron={false} />
            <Item title="Connected host" subtitle={hostVersion ? `Version ${hostVersion}` : 'Version unavailable until the host reports it'} subtitleLines={0} />
            <Item title="Get mobile builds" subtitle="Choose the stable or beta release you want to test" subtitleLines={0}
                onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/releases')} />
        </ItemGroup>
        <ItemGroup title="Troubleshooting" footer="Diagnostics contain durations, counts and status codes. Credentials, terminal content and private identifiers are excluded.">
            <Item title={details === undefined ? 'Show diagnostics' : 'Hide diagnostics'}
                subtitle="Connection and terminal events, with app build details"
                onPress={() => { setCopied(false); setDetails((value) => value === undefined ? diagnosticText() : undefined); }} />
            {details !== undefined && <>
                <Text selectable style={{ marginHorizontal: 16, marginBottom: 12, color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{details}</Text>
                <Item title={copied ? 'Diagnostics copied' : 'Copy diagnostics'} onPress={() => {
                    void Clipboard.setStringAsync(details).then(() => setCopied(true)).catch(() => Modal.alert('Copy failed', 'Please try again.'));
                }} />
            </>}
            {appConfig.publicBaseUrl && <Item title="Troubleshooting guide" onPress={() => openExternalUrl(`${appConfig.publicBaseUrl}/docs/troubleshooting`)} />}
        </ItemGroup>
    </>;
}
