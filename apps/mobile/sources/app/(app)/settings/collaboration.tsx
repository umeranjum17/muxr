import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { Platform, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/storage';
import { listPairedGrants, type StoredHostedGrant } from '@/state/hostedE2ee';
import {
    applyCollaboration,
    hasPendingCollaboration,
    loadCollaborationIntent,
    reconcileCollaboration,
    saveCollaborationIntent,
    selectCollaborationMachines,
    type CollaborationIntent,
    type CollaborationMachine,
    type CollaborationReport,
    type PeerRequester,
} from '@/collaboration/computerCollaboration';
import { requestPairedMachine } from '@/collaboration/scopedMachineClient';

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

    const refresh = React.useCallback(async () => {
        setBusy(true);
        try {
            const [paired, stored] = await Promise.all([listPairedGrants(), loadCollaborationIntent()]);
            const machines = machinesFor(paired, stored);
            const request = requesterFor(paired);
            const nextReport = hasPendingCollaboration(stored)
                ? await applyCollaboration(stored, machines, request)
                : await reconcileCollaboration(stored, machines, request);
            await saveCollaborationIntent(nextReport.intent);
            setGrants(paired);
            setIntent(nextReport.intent);
            setReport(nextReport);
            setSelected(nextReport.intent.selectedMachineIds);
        } finally {
            setBusy(false);
        }
    }, [machinesFor, requesterFor]);

    useFocusEffect(React.useCallback(() => {
        void refresh().catch((cause) => Modal.alert('Collaboration unavailable', cause instanceof Error ? cause.message : String(cause)));
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
            };
        });
    }, [grants, intent, liveMachines, report]);

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
        const next = selectCollaborationMachines(intent, chosen);
        await saveCollaborationIntent(next);
        setIntent(next);
        setBusy(true);
        try {
            const nextReport = await applyCollaboration(next, liveMachinesNow, requesterFor(grants));
            setIntent(nextReport.intent);
            setReport(nextReport);
            setSelected(nextReport.intent.selectedMachineIds);
        } finally {
            setBusy(false);
        }
    };

    const confirmSelection = async () => {
        if (selected.length < 2 || selected.length > 6) {
            Modal.alert('Select 2–6 computers', 'Computer collaboration needs at least two paired computers.');
            return;
        }
        const confirmed = await Modal.confirm(
            'Connect these computers?',
            'They will be able to read agent output and send prompts to one another. The computers connect directly afterward; this phone is not required to keep the connection working.',
            { confirmText: 'Connect computers' },
        );
        if (confirmed) await runSelection(selected);
    };

    const disconnect = async () => {
        const confirmed = await Modal.confirm(
            'Disconnect collaboration?',
            'Each computer revokes incoming access before the matching outgoing connection is removed. Offline computers stay pending until they can confirm revocation.',
            { confirmText: 'Disconnect', destructive: true },
        );
        if (confirmed) await runSelection([]);
    };

    const selectionChanged = intent !== undefined
        && [...selected].sort().join('\0') !== [...intent.selectedMachineIds].sort().join('\0');
    const hasCollaboration = intent !== undefined && (intent.selectedMachineIds.length >= 2 || intent.edges.length > 0);
    const pendingCollaboration = intent !== undefined && hasPendingCollaboration(intent);

    return (
        <ItemList>
            <ItemGroup
                title="Computers"
                footer="Select 2–6 paired computers. Online means the host answered now; otherwise status stays Unknown rather than guessing that an inactive computer is offline."
            >
                {rows.map((row) => {
                    const checked = selected.includes(row.machineId);
                    const state = row.collaborationState ?? (checked ? 'Setting up' : undefined);
                    const error = report?.errors[row.machineId];
                    return (
                        <Item
                            key={row.machineId}
                            title={row.name}
                            subtitle={`${[row.platform, row.online ? 'Online' : 'Unknown', state].filter(Boolean).join(' • ')}${error ? `\n${error}` : ''}`}
                            subtitleLines={2}
                            icon={<Ionicons name="desktop-outline" size={28} color={row.online ? theme.colors.status.connected : theme.colors.textSecondary} />}
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
                {rows.length === 0 && (
                    <Item title="Pair at least two computers first" subtitle="Return to Settings and pair each computer with this phone." showChevron={false} />
                )}
            </ItemGroup>

            <ItemGroup title="Permissions" footer="Shell access, terminal takeover, closing workspaces, worktree landing, and arbitrary plugin calls are never included.">
                <Item
                    title="Read agent output and send prompts"
                    subtitle="List sessions, read status and output, watch completion, and deliver prompts"
                    icon={<Ionicons name="shield-checkmark-outline" size={28} color="#5856D6" />}
                    detail="Recommended"
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup>
                <Item
                    title={selectionChanged ? 'Confirm collaboration' : pendingCollaboration ? 'Retry setup' : 'Refresh collaboration'}
                    subtitle="Selected computers connect directly after phone authorization"
                    icon={<Ionicons name="git-network-outline" size={28} color="#007AFF" />}
                    loading={busy}
                    disabled={busy || selectionChanged && selected.length < 2}
                    showChevron={false}
                    onPress={() => void (selectionChanged ? confirmSelection() : refresh())}
                />
                {hasCollaboration && (
                    <Item
                        title="Disconnect collaboration"
                        subtitle="Revoke computer-to-computer access; phone pairings stay intact"
                        icon={<Ionicons name="unlink-outline" size={28} color={theme.colors.textDestructive} />}
                        destructive
                        disabled={busy}
                        showChevron={false}
                        onPress={() => void disconnect()}
                    />
                )}
            </ItemGroup>

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
