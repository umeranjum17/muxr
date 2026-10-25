/**
 * The Computers sheet, opened over an agent: the one place for computers. It
 * opens the connected computer's screen, lists every computer this phone has
 * paired, marking the one the agent runs on, lets the person point the agent
 * at another online computer, and adds a computer of their own or a cloud one.
 * One list, built on the pairing grants the app already keeps — there is no
 * second registry of computers.
 *
 * The app holds one live connection, so a computer that is not the connected
 * one is checked with the same fresh paired-machine link collaboration opens;
 * until that check answers the row says "Checking…" rather than guessing.
 */

import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { getCachedConnectionSettings, sshTunnelAvailable } from '@/connection';
import { listPairedGrants, type StoredHostedGrant } from '@/pairing/e2ee';
import { openPairedMachine, SshComputerNeedsActivation } from '@/collaboration';
import { pairMachine } from '@/pairing';
import { useAuth } from '@/account/ui';
import { useAllMachines, useSession, useSocketStatus } from '@/catalog/store';
import { realtimeMachineSwitchGuard } from '@/conversation/session';
import { Modal } from '@/modal';
import { ActionSheet } from '@/modal/components/ActionSheet';
import { hasBoatComputer } from '@/cloud';
import { sync } from '@/catalog/sync';
import { resolveAgentCatalog } from '@/catalog';

/** Plain states a row can show. "Not paired" is a computer the app is
 * connected to that this phone keeps no pairing for. */
type ComputerState = 'online' | 'asleep' | 'offline' | 'not-paired' | 'ssh';

export interface ComputerRow {
    id: string;
    name: string;
    state: ComputerState;
    inUse: boolean;
    checking: boolean;
    grant?: StoredHostedGrant;
    disabledReason?: string;
    readiness?: string;
}

const STATE_LABEL: Record<ComputerState, string> = {
    online: 'Online',
    ssh: 'Checked when you pick it',
    asleep: 'Asleep',
    offline: 'Offline',
    'not-paired': 'Not paired',
};

/** Why an offline computer cannot be picked. Plain words, no internal ids. */
function stateReason(state: ComputerState, inUse: boolean): string | undefined {
    if (inUse) return undefined;
    switch (state) {
        case 'offline': return 'Turn it on and keep muxr running to use it.';
        case 'asleep': return 'Not answering right now.';
        case 'not-paired': return 'No pairing is saved on this phone.';
        case 'online':
        case 'ssh': return undefined;
    }
}

/** The active computer answers on the app's own link; every other one answers
 * a fresh probe. A paired computer the probe has not answered yet is still
 * being checked. */
function resolveComputerState(isActive: boolean, socketConnected: boolean, probed: boolean | 'ssh' | undefined): ComputerState {
    if (isActive) return socketConnected ? 'online' : 'asleep';
    if (probed === 'ssh') return 'ssh';
    return probed === true ? 'online' : 'offline';
}

function stateColor(state: ComputerState, theme: ReturnType<typeof useUnistyles>['theme']): string {
    switch (state) {
        case 'online': return theme.colors.status.connected;
        // Amber: known to this phone, just not answering — distinct from a
        // computer the phone has never reached.
        case 'asleep': return '#FF9F0A';
        case 'offline': return theme.colors.status.disconnected;
        case 'not-paired':
        case 'ssh': return theme.colors.textSecondary;
    }
}

/** A fresh liveness check that does not touch the app's active connection: open
 * the pairing's own link and see whether the host answers. Resolves true when
 * the link opens, false when it goes stale or does not answer in time. */
async function probeComputer(grant: StoredHostedGrant, agentKind?: string, agentName = 'Agent'): Promise<{ state: boolean | 'ssh'; readiness?: string }> {
    let client;
    let reached = false;
    try {
        if (grant.machineId !== getCachedConnectionSettings().machineId) client = await openPairedMachine(grant);
        reached = true;
        if (agentKind === undefined || agentKind === 'shell') return { state: true };
        const catalog = await (client ?? sync).request('herdr.agentKinds', {});
        const agent = resolveAgentCatalog(catalog).options.find((entry) => entry.kind === agentKind);
        let readiness = `${agentName} installed`;
        if (agent === undefined || agent.availability !== 'installed') readiness = `${agentName} not installed: install`;
        else if (agent.signedIn === 'no') readiness = `${agentName} signed out: sign in`;
        else if (agent.signedIn === 'yes') readiness = `${agentName} ready`;
        return { state: true, readiness };
    } catch (cause) {
        if (cause instanceof SshComputerNeedsActivation) return { state: 'ssh' };
        if (reached) return { state: true, readiness: `Could not check ${agentName}: ${cause instanceof Error ? cause.message : String(cause)}` };
        return { state: false };
    } finally { client?.close(); }
}

function displayName(grant: StoredHostedGrant, liveName: string | undefined): string {
    const trimmed = liveName?.trim();
    if (trimmed) return trimmed;
    const paired = grant.machineName?.trim();
    if (paired) return paired;
    return 'Paired computer';
}

export function ComputerRows({ rows, onPick, loadingId, wrapNames = false }: { rows: ComputerRow[]; onPick: (row: ComputerRow) => void; loadingId?: string; wrapNames?: boolean }): React.JSX.Element {
    const { theme } = useUnistyles();
    const { width, fontScale } = useWindowDimensions();
    const narrow = width < 200;
    const wrapHeading = wrapNames && width / fontScale < 200;
    return (
        <ItemGroup title="Your computers" titleStyle={{ color: theme.colors.groupped.sectionTitle }} headerStyle={wrapHeading ? { paddingHorizontal: 12 } : undefined}>
            {rows.map((row) => {
                const availability = row.checking ? 'Checking…' : STATE_LABEL[row.state];
                const reason = row.checking ? undefined : [stateReason(row.state, row.inUse), row.disabledReason].filter(Boolean).join(' ');
                const subtitle = [availability, row.inUse ? 'In use' : undefined, row.readiness, reason]
                    .filter((part): part is string => Boolean(part)).join(' • ');
                const selectable = (row.state === 'online' || row.state === 'ssh') && !row.inUse && row.grant !== undefined && row.disabledReason === undefined;
                return (
                    <Item key={row.id} title={row.name} titleLines={wrapNames ? 0 : undefined}
                        style={wrapNames && narrow ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}
                        titleStyle={{ color: theme.colors.text }} subtitleStyle={{ color: theme.colors.textSecondary }}
                        subtitle={subtitle} subtitleLines={0}
                        icon={<View style={row.state !== 'online' ? { opacity: 0.5 } : undefined}>
                            <Ionicons name="desktop-outline" size={29} color={stateColor(row.state, theme)} />
                        </View>}
                        rightElement={row.inUse ? <Ionicons name="checkmark-circle" size={25} color={theme.colors.status.connected} /> : undefined}
                        loading={row.checking || loadingId === row.id} showChevron={false}
                        onPress={selectable ? () => onPick(row) : undefined}
                        accessibilityLabel={[row.name, availability, row.inUse ? 'In use' : undefined, row.readiness, reason].filter(Boolean).join('. ')}
                    />
                );
            })}
        </ItemGroup>
    );
}

/** `onViewScreen` is given only where the connected computer's screen can be
 * opened (the desktop view is available and this phone controls the pane). */
export function ComputersSheet({ visible, sessionId, agentKind, agentName, onClose, onViewScreen, onLeave }: { visible: boolean; sessionId?: string; agentKind?: string; agentName?: string; onClose: () => void; onViewScreen?: () => void; onLeave?: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const router = useRouter();
    const auth = useAuth();
    const socketStatus = useSocketStatus();
    const liveMachines = useAllMachines({ includeOffline: true });
    const session = useSession(sessionId ?? '');
    const [hasCloud, setHasCloud] = React.useState(false);
    const { width, fontScale } = useWindowDimensions();
    const wrapAddCopy = sessionId === undefined && width / fontScale < 200;
    const addCopyStyle = wrapAddCopy ? { flexDirection: 'column' as const, alignItems: 'stretch' as const, paddingHorizontal: 8 } : undefined;
    const [readiness, setReadiness] = React.useState<Record<string, string>>({});
    const [grants, setGrants] = React.useState<StoredHostedGrant[]>([]);
    const [probes, setProbes] = React.useState<Record<string, boolean | 'ssh'>>({});
    const [switching, setSwitching] = React.useState<string | null>(null);
    // pairMachine stores the next machineId before the socket reconnects, so a
    // live read would label the picked computer asleep and reset the probes of
    // the one being left to Checking… for about a second. Freeze what the rows
    // read from until the switch settles or fails instead.
    const [switchSnapshot, setSwitchSnapshot] = React.useState<{ from: string | undefined; connected: boolean } | null>(null);
    const [confirm, setConfirm] = React.useState<{ row: ComputerRow; voiceActive: boolean } | null>(null);

    const activeMachineId = getCachedConnectionSettings().machineId;
    const agentMachineId = session?.metadata?.machineId ?? activeMachineId;
    const socketConnected = socketStatus.status === 'connected';
    const frozen = switching !== null && switchSnapshot !== null;
    const effectiveActiveId = frozen ? switchSnapshot.from : activeMachineId;
    const effectiveConnected = frozen ? switchSnapshot.connected : socketConnected;

    // Load the pairings and run a fresh host check on every computer that is
    // not the connected one, so each row reports what it can reach now. A
    // switch in flight keeps the frozen list instead of re-probing mid-flight.
    React.useEffect(() => {
        if (!visible || switching !== null) return;
        let cancelled = false;
        setProbes({});
        setReadiness({});
        void hasBoatComputer().then((exists) => { if (!cancelled) setHasCloud(exists); }).catch((cause) => {
            if (!cancelled) Modal.alert('Could not check your cloud computer', cause instanceof Error ? cause.message : String(cause));
        });
        void listPairedGrants().then((all) => {
            if (cancelled) return;
            setGrants(all);
            for (const grant of all) {
                if (grant.machineId === activeMachineId && agentKind === undefined) continue;
                void probeComputer(grant, agentKind, agentName).then((result) => {
                    if (cancelled) return;
                    setProbes((current) => ({ ...current, [grant.machineId]: result.state }));
                    if (result.readiness !== undefined) setReadiness((current) => ({ ...current, [grant.machineId]: result.readiness! }));
                });
            }
        }).catch((cause) => {
            if (cancelled) return;
            Modal.alert('Could not load computers', cause instanceof Error ? cause.message : String(cause));
        });
        return () => { cancelled = true; };
    }, [visible, activeMachineId, switching, agentKind, agentName]);

    const rows = React.useMemo<ComputerRow[]>(() => {
        const liveById = new Map(liveMachines.map((machine) => [machine.id, machine]));
        const pairedIds = new Set(grants.map((grant) => grant.machineId));
        const next: ComputerRow[] = [];
        for (const grant of grants) {
            const isActive = grant.machineId === effectiveActiveId;
            const probed = probes[grant.machineId];
            const state = resolveComputerState(isActive, effectiveConnected, probed);
            next.push({
                id: grant.machineId,
                name: displayName(grant, liveById.get(grant.machineId)?.metadata?.displayName),
                state,
                inUse: grant.machineId === agentMachineId,
                checking: !isActive && probed === undefined,
                grant,
                readiness: readiness[grant.machineId],
                disabledReason: state === 'ssh' && !sshTunnelAvailable() ? 'Open this computer in the muxr phone app.' : undefined,
            });
        }
        // A connected computer this phone holds no pairing for: real, and
        // honestly labelled rather than hidden.
        for (const machine of liveMachines) {
            if (pairedIds.has(machine.id)) continue;
            if (machine.id !== effectiveActiveId) continue;
            next.push({
                id: machine.id,
                name: machine.metadata?.displayName?.trim() || 'This computer',
                state: 'not-paired',
                inUse: machine.id === agentMachineId,
                checking: false,
            });
        }
        return next;
    }, [effectiveActiveId, agentMachineId, grants, liveMachines, probes, effectiveConnected, readiness]);

    // Tapping another online computer asks first, through the app's own dialog
    // rather than the stock OS alert, whose caps'd buttons and system chrome
    // would not look like the rest of muxr.
    const requestSwitch = React.useCallback((row: ComputerRow) => {
        if (row.grant === undefined || switching !== null) return;
        setConfirm({ row, voiceActive: !realtimeMachineSwitchGuard(row.id).allowed });
    }, [switching]);

    const doSwitch = React.useCallback(async () => {
        const pending = confirm;
        if (pending === null) return;
        const { row, voiceActive } = pending;
        if (row.grant === undefined) return;
        setConfirm(null);
        const grant = row.grant;
        setSwitchSnapshot({ from: getCachedConnectionSettings().machineId, connected: socketStatus.status === 'connected' });
        setSwitching(row.id);
        try {
            const reachable = await probeComputer(grant);
            if (reachable.state === false) throw new Error(`Couldn't reach ${row.name}. Nothing was started.`);
            const activated = await pairMachine({ grant, endVoiceIfPinned: voiceActive });
            if (!activated.ok) throw new Error(activated.reason === 'failed' ? activated.message : 'Realtime voice is still pinned to another computer');
            await auth.login(activated.credential, activated.secretKey);
            onClose();
            // The agent on the computer just left stays where it was; the
            // stack holds one agent over Home, so back lands on the newly
            // connected computer's agents.
            if (sessionId !== undefined) router.back();
        } catch (cause) {
            Modal.alert('Could not switch computer', cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSwitching(null);
            setSwitchSnapshot(null);
        }
    }, [auth, confirm, onClose, router, socketStatus.status, sessionId]);

    const body = (
        <View>
            {onViewScreen !== undefined && (
                <ItemGroup>
                    <Item
                        title="View screen"
                        titleStyle={{ color: theme.colors.text }}
                        subtitle={rows.find((row) => row.id === effectiveActiveId)?.name}
                        titleLines={0}
                        subtitleLines={0}
                        subtitleStyle={{ color: theme.colors.textSecondary }}
                        showChevron
                        onPress={onViewScreen}
                        icon={<Ionicons name="tv-outline" size={29} color={theme.colors.textSecondary} />}
                    />
                </ItemGroup>
            )}

            <ComputerRows rows={rows} onPick={requestSwitch} loadingId={switching ?? undefined} wrapNames={sessionId === undefined} />

            <ItemGroup title="Add a computer" titleStyle={{ color: theme.colors.groupped.sectionTitle }} headerStyle={wrapAddCopy ? { paddingHorizontal: 12 } : undefined}>
                <Item
                    title="Pair a computer"
                    style={addCopyStyle}
                    titleStyle={{ color: theme.colors.text }}
                    subtitle="Install muxr on it, then pair"
                    titleLines={0}
                    subtitleLines={0}
                    subtitleStyle={{ color: theme.colors.textSecondary }}
                    showChevron
                    onPress={() => { onClose(); onLeave?.(); router.push('/add-computer'); }}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.textSecondary} />}
                />
                {(sessionId !== undefined || !hasCloud) && <Item
                    title={sessionId === undefined ? 'Create a cloud computer' : 'Add a cloud computer'}
                    style={addCopyStyle}
                    titleStyle={{ color: theme.colors.text }}
                    subtitle={Platform.OS === 'web' ? 'Set up from the muxr phone app' : 'Boat · from $0.036 an hour'}
                    titleLines={0}
                    subtitleLines={0}
                    subtitleStyle={{ color: theme.colors.textSecondary }}
                    showChevron
                    onPress={() => { onClose(); onLeave?.(); router.push('/cloud-computer'); }}
                    icon={<Ionicons name="cloud-outline" size={29} color={theme.colors.textSecondary} />}
                />}
            </ItemGroup>
        </View>
    );

    // A sheet over the session paints from the dark surface whatever the app
    // is set to; the scope sits here, in this sheet's own render, so the rows
    // it mounts on its own state (the pairing read, the liveness probes) read
    // it too instead of the phone's theme.
    const content = (
        <>
            <OptionSheet
                visible={visible}
                title={sessionId === undefined ? 'Start on' : 'Computers'}
                options={[]}
                onSelect={() => undefined}
                onClose={onClose}
                maxWidth={560}
                body={body}
            />
            {confirm !== null && (
                <ActionSheet
                    config={{
                        id: 'computer-switch-confirm',
                        type: 'confirm',
                        title: confirm.voiceActive ? 'End voice and switch?' : `Switch to ${confirm.row.name}?`,
                        message: confirm.voiceActive
                            ? 'Realtime voice stays pinned to the computer where it started.'
                            : 'The app reconnects to this computer with the stored pairing, so the next prompt runs there. You can switch back the same way.',
                        cancelText: 'Cancel',
                        confirmText: confirm.voiceActive ? 'End voice and switch' : 'Switch',
                        destructive: confirm.voiceActive,
                    }}
                    onClose={() => setConfirm(null)}
                    onConfirm={(value) => { if (value) { void doSwitch(); } else { setConfirm(null); } }}
                />
            )}
        </>
    );
    return sessionId === undefined ? content : <ScopedTheme name="dark">{content}</ScopedTheme>;
}
