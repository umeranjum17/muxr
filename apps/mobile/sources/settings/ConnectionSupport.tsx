import * as React from 'react';
import { Platform, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useLocalSettingMutable } from '@/catalog/store';
import { formatConnectionDiagnosticsForReport } from '@/catalog/diagnostics';
import { loadAppConfig } from '@/catalog';
import { getAppBuildNumber, getAppVersion } from '@/utils/appVersion';
import { knownHostVersion, versionsMismatch } from '@/utils/versionStatus';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { t } from '@/text';
import { useHostUpdate } from './useHostUpdate';
import { useDeviceAuthority } from '@/pairing';

// Explanation prose drops below its action row at full card width (same tokens
// as the connection screen's hint), so the row keeps icon and status line
// aligned instead of wrapping a paragraph in the inset text column.
const stylesheet = StyleSheet.create((theme) => ({
    guidance: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

/** One destination for installed versions, update guidance and connection evidence. */
export function ConnectionSupport({ hostVersion: reportedHost }: { hostVersion?: string }) {
    const { theme } = useUnistyles();
    const appVersion = getAppVersion();
    const build = getAppBuildNumber();
    const appConfig = loadAppConfig();
    const release = knownHostVersion(appConfig.releaseVersion);
    const exactRelease = release?.split('-')[0] === appVersion.split('-')[0] ? release : undefined;
    const update = useHostUpdate(exactRelease ?? 'unknown');
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const installBlocked = authorityLoading
        ? 'Checking device access.'
        : authority !== 'control'
            ? 'View-only access cannot check or install on the computer.'
            : undefined;
    const hostVersion = knownHostVersion(reportedHost);
    const mismatch = versionsMismatch(appVersion, hostVersion);
    const [details, setDetails] = React.useState<string>();
    const [copied, setCopied] = React.useState(false);
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const versionClick = useMultiClick(() => {
        setDevModeEnabled(!devModeEnabled);
        Modal.alert(t('modals.developerMode'), devModeEnabled ? t('modals.developerModeDisabled') : t('modals.developerModeEnabled'));
    }, { requiredClicks: 10, resetTimeout: 2000 });
    // The build metadata records the source commit date, never the phone's clock.
    const sourceCommit = appConfig.buildCommitSha?.trim().slice(0, 12) || undefined;
    const sourceDate = (() => {
        const stamp = appConfig.buildCommitTimestamp?.trim();
        if (!stamp) return undefined;
        const parsed = new Date(stamp);
        return Number.isNaN(parsed.getTime()) ? undefined : `${parsed.toISOString().slice(0, 10)} UTC`;
    })();
    const sourceLine = sourceCommit === undefined && sourceDate === undefined
        ? 'Source unavailable'
        : `${sourceCommit ?? 'commit unavailable'} · source date ${sourceDate ?? 'unavailable'}`;
    const guidance = mismatch
        ? 'This does not by itself mean the connection is broken. If features behave differently, update the older component using the same release channel. Installing restarts the host; the connection pauses while it does.'
        : 'Keep this app and check for a compatible host release. Any installation requires confirmation; installing restarts the host.';
    const statusSubtitle = update.message
        ? `${update.message}${installBlocked === undefined ? '' : ` · ${installBlocked}`}`
        : `App ${appVersion}${hostVersion === undefined ? '' : ` · host ${hostVersion}`}${installBlocked === undefined ? '' : ` · ${installBlocked}`}`;
    const diagnosticText = () => [
        `App ${appVersion}${build ? ` / build ${build}` : ''}; host ${hostVersion ?? 'unknown'}`,
        `App source ${sourceLine}`,
        formatConnectionDiagnosticsForReport(),
    ].filter(Boolean).join('\n');
    return <>
        <ItemGroup title="Installed versions">
            <Item
                title={mismatch ? 'App and host versions differ' : 'Check compatibility / align host'}
                icon={mismatch ? <Ionicons name="warning-outline" size={24} color={theme.colors.box.warning.border} /> : undefined}
                subtitle={statusSubtitle}
                subtitleLines={0}
                showChevron={false}
                loading={update.busy}
                disabled={installBlocked !== undefined}
                onPress={installBlocked === undefined ? () => void update.check() : undefined}
            />
            {!update.message && <Text style={stylesheet.guidance}>{guidance}</Text>}
            <Item title={Platform.OS === 'web' ? 'Web app' : 'Installed app'} subtitle={`Version ${exactRelease ?? appVersion}${build ? ` · build ${build}` : ''}`}
                subtitleLines={0} onPress={versionClick} showChevron={false} />
            <Item title="Source" subtitle={sourceLine} subtitleLines={0} />
            <Item title="Connected host" subtitle={hostVersion ? `Version ${hostVersion}` : 'Unavailable until the host reports it'} subtitleLines={0} />
            <Item title="Get mobile builds" subtitle="Choose the stable or nightly release you want to test" subtitleLines={0}
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
