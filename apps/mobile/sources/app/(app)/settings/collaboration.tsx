import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { Platform, Switch, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/storage';
import { listPairedGrants, type StoredHostedGrant } from '@/state/hostedE2ee';
import {
    applyCollaboration,
    grantPeerAuthority,
    hasPendingCollaboration,
    loadCollaborationIntent,
    reconcileCollaboration,
    revokePeerAuthority,
    saveCollaborationIntent,
    type CollaborationIntent,
    type CollaborationMachine,
    type CollaborationReport,
    type PeerRequester,
} from '@/collaboration';
import { requestPairedMachine } from '@/collaboration';

function showCollaborationError(cause: unknown) {
    Modal.alert('Collaboration unavailable', cause instanceof Error ? cause.message : String(cause));
}

function issueLabel(kind: CollaborationReport['issues'][string]['kind']): string {
    switch (kind) {
        case 'outdated': return 'Update required';
        case 'unauthorized': return 'Pair again';
        case 'unavailable': return 'Restart required';
        case 'offline': return 'Unavailable';
    }
}

function platformName(value: string | undefined): string | undefined {
    switch (value?.toLowerCase()) {
        case 'darwin': return 'macOS';
        case 'win32': return 'Windows';
        case 'linux': return 'Linux';
        case 'ios': return 'iOS';
        case 'android': return 'Android';
        default: return value?.trim() || undefined;
    }
}

export default function ComputerCollaborationScreen() {
    const { theme } = useUnistyles();
    const liveMachines = useAllMachines({ includeOffline: true });
    const liveRef = React.useRef(liveMachines);
    liveRef.current = liveMachines;
    const [grants, setGrants] = React.useState<StoredHostedGrant[]>([]);
    const [intent, setIntent] = React.useState<CollaborationIntent>();
    const [report, setReport] = React.useState<CollaborationReport>();
    const [selected, setSelected] = React.useState<string[]>([]);
    const [busy, setBusy] = React.useState(false);

    const machinesFor = React.useCallback((paired: StoredHostedGrant[], stored: CollaborationIntent): CollaborationMachine[] => {
        const liveById = new Map(liveRef.current.map((machine) => [machine.id, machine]));
        const knownById = new Map(stored.machines.map((machine) => [machine.machineId, machine]));
        return paired.map((grant) => {
            const live = liveById.get(grant.machineId);
            const displayName = live?.metadata?.displayName?.trim();
            const host = live?.metadata?.host?.trim();
            const safeHost = host && !/^machine[-_]/i.test(host) ? host : undefined;
            return {
                machineId: grant.machineId,
                machineSigningPublicKey: grant.machineSigningPublicKey,
                name: displayName || grant.machineName || safeHost || knownById.get(grant.machineId)?.name || 'Paired computer',
                platform: platformName(live?.metadata?.platform) ?? knownById.get(grant.machineId)?.platform,
            };
        });
    }, []);

    const requesterFor = React.useCallback((paired: StoredHostedGrant[]): PeerRequester => {
        const byId = new Map(paired.map((grant) => [grant.machineId, grant]));
        return async (machineId, type, params) => {
            const grant = byId.get(machineId);
            if (grant === undefined) throw new Error('Pair this computer with the phone again to continue.');
            return requestPairedMachine(grant, type, params);
        };
    }, []);

    const refresh = React.useCallback(async (): Promise<CollaborationReport> => {
        setBusy(true);
        try {
            const [paired, stored] = await Promise.all([listPairedGrants(), loadCollaborationIntent()]);
            setGrants(paired);
            setIntent(stored);
            setSelected(stored.selectedMachineIds);
            const machines = machinesFor(paired, stored);
            const request = requesterFor(paired);
            const nextReport = hasPendingCollaboration(stored)
                ? await applyCollaboration(stored, machines, request)
                : await reconcileCollaboration(stored, machines, request);
            await saveCollaborationIntent(nextReport.intent);
            setIntent(nextReport.intent);
            setReport(nextReport);
            setSelected(nextReport.intent.selectedMachineIds);
            return nextReport;
        } finally {
            setBusy(false);
        }
    }, [machinesFor, requesterFor]);

    useFocusEffect(React.useCallback(() => {
        void refresh().catch(showCollaborationError);
    }, [refresh]));

    const rows = React.useMemo(() => {
        if (intent === undefined) return [];
        const liveById = new Map(liveMachines.map((machine) => [machine.id, machine]));
        const grantById = new Map(grants.map((grant) => [grant.machineId, grant]));
        const knownById = new Map(intent.machines.map((machine) => [machine.machineId, machine]));
        const ids = [...new Set([...grants.map((grant) => grant.machineId), ...intent.machines.map((machine) => machine.machineId)])];
        return ids.map((machineId) => {
            const grant = grantById.get(machineId);
            const live = liveById.get(machineId);
            const known = knownById.get(machineId);
            const displayName = live?.metadata?.displayName?.trim();
            const host = live?.metadata?.host?.trim();
            const safeHost = host && !/^machine[-_]/i.test(host) ? host : undefined;
            return {
                machineId,
                grant,
                name: displayName || grant?.machineName || safeHost || known?.name || 'Paired computer',
                platform: platformName(live?.metadata?.platform) ?? known?.platform,
                online: report?.reachableMachineIds.includes(machineId) === true,
                collaborationState: report?.states[machineId],
                issue: report?.issues[machineId],
            };
        });
    }, [grants, intent, liveMachines, report]);

    const selectionChanged = intent !== undefined
        && [...selected].sort().join('\0') !== [...intent.selectedMachineIds].sort().join('\0');
    const collaborationEnabled = intent !== undefined && intent.selectedMachineIds.length >= 2;
    const pendingCollaboration = intent !== undefined && hasPendingCollaboration(intent);
    const disconnecting = intent?.edges.some((edge) => edge.disconnect !== undefined && edge.disconnect.repair !== true) === true;

    const presentReport = (nextReport: CollaborationReport, machineIds: string[]) => {
        const byId = new Map(nextReport.intent.machines.map((machine) => [machine.machineId, machine.name]));
        if (machineIds.length === 0) {
            Modal.alert(nextReport.intent.edges.length === 0 ? 'Collaboration disconnected' : 'Disconnecting',
                nextReport.intent.edges.length === 0 ? 'Computer-to-computer access has been revoked.' : 'Access is fenced and will finish revoking when every computer is reachable.');
            return;
        }
        const issue = machineIds.map((id) => [byId.get(id) ?? 'Computer', nextReport.issues[id]] as const).find(([, value]) => value !== undefined);
        if (issue?.[1] !== undefined) {
            Modal.alert(issueLabel(issue[1].kind), `${issue[0]}: ${issue[1].message}`);
            return;
        }
        const error = machineIds.map((id) => [byId.get(id) ?? 'Computer', nextReport.errors[id]] as const).find(([, value]) => value !== undefined);
        if (error?.[1] !== undefined) {
            Modal.alert('Collaboration could not finish', `${error[0]}: ${error[1]}`);
            return;
        }
        if (machineIds.every((id) => nextReport.states[id] === 'Connected')) {
            Modal.alert('Computers connected', 'Local agents can now list, read, watch, and prompt agents on the selected computers.');
            return;
        }
        Modal.alert('Still connecting', 'Keep muxr running on every selected computer, then tap Retry connection.');
    };

    const toggle = (machineId: string, grant: StoredHostedGrant | undefined) => {
        if (busy) return;
        if (selected.includes(machineId)) {
            setSelected(selected.filter((id) => id !== machineId));
            return;
        }
        if (grant === undefined) {
            Modal.alert('Pair this computer again', 'The phone pairing is required to change collaboration safely. Existing computer collaboration is not revoked by forgetting a phone pairing.');
            return;
        }
        if (grant.authority === 'observe') {
            Modal.alert('Phone control required', 'This pairing can only observe the computer. Pair it with phone control before authorizing collaboration.');
            return;
        }
        if (selected.length >= 6) {
            Modal.alert('Six computer limit', 'Disconnect one computer before adding another.');
            return;
        }
        setSelected([...selected, machineId]);
    };

    const runSelection = async (machineIds: string[]) => {
        if (intent === undefined) return;
        const liveMachinesNow = machinesFor(grants, intent);
        const machineById = new Map(liveMachinesNow.map((machine) => [machine.machineId, machine]));
        const chosen = machineIds.map((id) => machineById.get(id)).filter((machine): machine is CollaborationMachine => machine !== undefined);
        if (chosen.length !== machineIds.length) {
            Modal.alert('Pair every selected computer', 'Pair the missing computer with this phone again before changing collaboration.');
            return;
        }
        setBusy(true);
        try {
            const nextReport = chosen.length === 0
                ? await revokePeerAuthority({ intent, machines: liveMachinesNow, request: requesterFor(grants) })
                : await grantPeerAuthority({ intent, selected: chosen, machines: liveMachinesNow, request: requesterFor(grants) });
            setIntent(nextReport.intent);
            setReport(nextReport);
            setSelected(nextReport.intent.selectedMachineIds);
            presentReport(nextReport, machineIds);
        } finally {
            setBusy(false);
        }
    };

    const confirmSelection = async (machineIds = selected) => {
        if (machineIds.length < 2 || machineIds.length > 6) {
            Modal.alert('Select 2–6 computers', 'Select the computers first, then turn on the permission.');
            return;
        }
        const confirmed = await Modal.confirm(
            'Allow agent collaboration?',
            'The selected computers will be able to read agent output and send prompts to one another. They connect directly afterward; this phone is not required to keep the connection working.',
            { confirmText: 'Allow' },
        );
        if (confirmed) await runSelection(machineIds);
    };

    const disconnect = async () => {
        const confirmed = await Modal.confirm(
            'Disconnect collaboration?',
            'Each computer revokes incoming access before the matching outgoing connection is removed. Offline computers stay pending until they can confirm revocation.',
            { confirmText: 'Disconnect', destructive: true },
        );
        if (confirmed) await runSelection([]);
    };

    const togglePermission = async (enabled: boolean) => {
        if (busy) return;
        try {
            if (enabled) await confirmSelection();
            else if (collaborationEnabled) await disconnect();
        } finally {
            setIntent((current) => current === undefined ? current : { ...current });
        }
    };

    return (
        <ItemList>
            <ItemGroup
                title="Computers"
                footer="Select 2–6 paired computers. Each status comes from a fresh host check and tells you whether to update, restart, pair again, or retry."
            >
                {rows.map((row) => {
                    const checked = selected.includes(row.machineId);
                    const state = row.collaborationState ?? (checked ? selectionChanged ? 'Selected' : 'Setting up' : undefined);
                    const detail = row.issue?.message ?? report?.errors[row.machineId];
                    const availability = row.issue === undefined ? row.online ? 'Online' : 'Checking' : issueLabel(row.issue.kind);
                    return (
                        <Item
                            key={row.machineId}
                            title={row.name}
                            subtitle={`${[row.platform, availability, row.issue === undefined ? state : undefined].filter(Boolean).join(' • ')}${detail ? `\n${detail}` : ''}`}
                            subtitleLines={2}
                            icon={<Ionicons name="desktop-outline" size={28} color={row.online ? theme.colors.status.connected : row.issue ? '#FF9F0A' : theme.colors.textSecondary} />}
                            rightElement={busy && checked ? undefined : (
                                <Ionicons
                                    name={checked ? 'checkmark-circle' : 'ellipse-outline'}
                                    size={25}
                                    color={checked ? theme.colors.status.connected : theme.colors.textSecondary}
                                />
                            )}
                            loading={busy && checked}
                            showChevron={false}
                            selected={checked}
                            accessibilityLabel={`${checked ? 'Remove' : 'Select'} ${row.name}`}
                            onPress={() => toggle(row.machineId, row.grant)}
                        />
                    );
                })}
                {intent === undefined ? busy ? (
                    <Item title="Checking paired computers…" loading showChevron={false} />
                ) : (
                    <Item title="Could not read this phone's pairings" subtitle="Reopen this screen to try again." showChevron={false} />
                ) : rows.length === 0 && (
                    <Item title="Pair at least two computers first" subtitle="Return to Settings and pair each computer with this phone." showChevron={false} />
                )}
            </ItemGroup>

            <ItemGroup title="Permission" footer="Turn this off to revoke access. Starting new agents is not available yet. Shell, terminal takeover, destructive actions, and arbitrary plugin calls are never included.">
                <Item
                    title="Agent collaboration"
                    subtitle="Read agent output, watch completion, and send prompts"
                    icon={<Ionicons name="shield-checkmark-outline" size={28} color="#5856D6" />}
                    rightElement={(
                        <Switch
                            value={collaborationEnabled}
                            disabled={busy}
                            accessibilityLabel="Allow agent collaboration"
                            onValueChange={(enabled) => void togglePermission(enabled).catch(showCollaborationError)}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            {((collaborationEnabled && selectionChanged) || pendingCollaboration) && (
                <ItemGroup>
                    <Item
                        title={selectionChanged ? 'Apply computer changes' : disconnecting ? 'Retry disconnection' : 'Retry connection'}
                        subtitle={selectionChanged && selected.length < 2
                            ? 'Select at least two computers, or turn off Agent collaboration'
                            : disconnecting ? 'Finish revoking access when the computers are reachable' : 'Try again when every selected computer is reachable'}
                        icon={<Ionicons name={disconnecting ? 'unlink-outline' : 'refresh-outline'} size={28} color="#007AFF" />}
                        loading={busy}
                        disabled={busy || selectionChanged && selected.length < 2}
                        showChevron={false}
                        onPress={() => void (selectionChanged ? confirmSelection() : refresh().then((nextReport) => presentReport(nextReport, nextReport.intent.selectedMachineIds))).catch(showCollaborationError)}
                    />
                </ItemGroup>
            )}

            {Platform.OS === 'web' && (
                <View style={{ paddingHorizontal: 24, paddingBottom: 24 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                        Browser observe-only pairings cannot authorize collaboration. Use the muxr phone app or a control pairing.
                    </Text>
                </View>
            )}
        </ItemList>
    );
}
