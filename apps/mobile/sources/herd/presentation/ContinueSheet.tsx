import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ScopedTheme, StyleSheet, useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { listPairedGrants, type StoredHostedGrant } from '@/pairing/e2ee';
import { pairMachine } from '@/pairing';
import { useAuth } from '@/account/ui';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { sessionStopAfterHandoff } from '@/catalog/ops';
import { Modal } from '@/modal';
import { useAllMachines, useSession, useSocketStatus } from '@/catalog/store';
import { openPairedMachine, SshComputerNeedsActivation } from '@/collaboration';
import { SheetIcon } from '@/components/SheetIcon';
import { navigateToSession } from '../application/useNavigateToSession';
import { ComputerRows, type ComputerRow } from './ComputersSheet';

const HANDOFF_TIMEOUT_MS = 250_000;
const PROMPT_TIMEOUT_MS = 60_000;

function mapHomePath(path: string | undefined, sourceHome: string | undefined, targetHome: string | undefined): { cwd: string; folder: string } {
    if (path === undefined || sourceHome === undefined || targetHome === undefined) return { cwd: '~', folder: '~' };
    const home = sourceHome.replace(/[/\\]+$/, '');
    if (path !== home && !path.startsWith(`${home}/`) && !path.startsWith(`${home}\\`)) return { cwd: '~', folder: '~' };
    const relative = path.slice(home.length).replace(/^[/\\]+/, '');
    if (!relative) return { cwd: targetHome, folder: '~' };
    const separator = targetHome.includes('\\') && !targetHome.includes('/') ? '\\' : '/';
    const target = targetHome.replace(/[/\\]+$/, '');
    return { cwd: `${target}${separator}${relative.replace(/[/\\]+/g, separator)}`, folder: `~/${relative.replace(/\\/g, '/')}` };
}

/** Close the source only while it is at rest (strict: isSessionIdle also counts blocked/failed). Returns a notice when it stays open. */
async function retireSource(sessionId: string, sourceName: string): Promise<string | undefined> {
    const kept = (why: string) => `${why} It is still open on ${sourceName}. Close it when you are done.`;
    let refusal = 'You chose to keep it open.';
    const atRest = async (): Promise<boolean> => {
        const { agentStatus } = await sync.request('session.status', { sessionId });
        if (agentStatus === 'idle' || agentStatus === 'done') return true;
        refusal = agentStatus === undefined || agentStatus === 'unknown'
            ? 'The agent there could not be checked, so it was not closed.'
            : 'The agent there is not idle, so it was not closed.';
        return false;
    };
    try {
        if (!await atRest()) return kept(refusal);
        const result = await sessionStopAfterHandoff(sessionId, {
            confirmClose: async (prompt) => (await Modal.confirm(`${prompt.confirmText}?`, prompt.message, { cancelText: 'Cancel', confirmText: prompt.confirmText, destructive: true })) && atRest(),
            confirmRetry: async (reason) => (await Modal.confirm('Could not close the agent', reason, { cancelText: 'Cancel', confirmText: 'Retry' })) && atRest(),
        });
        return result.status === 'closed' ? undefined : kept(refusal);
    } catch (cause) {
        if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'agent-unavailable') return undefined;
        return kept(`It could not be closed: ${message(cause)}`);
    }
}

function message(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

export function ContinueRow({ agentKind, onOpen }: { agentKind: string | undefined; onOpen: () => void }): React.JSX.Element | null {
    const { theme } = useUnistyles();
    const [hasOther, setHasOther] = React.useState(false);
    React.useEffect(() => { let live = true; const current = getCachedConnectionSettings().machineId; void listPairedGrants().then((grants) => { if (live) setHasOther(grants.some((grant) => grant.machineId !== current)); }).catch(() => undefined); return () => { live = false; }; }, []);
    if (!hasOther || agentKind === undefined) return null;
    return <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel="Continue on another computer"
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }]}>
        <SheetIcon name="arrow-forward-circle-outline" size={18} color={theme.colors.textSecondary} />
        <Text style={[styles.label, { color: theme.colors.text }]}>Continue on another computer</Text>
        <SheetIcon name="chevron-forward" size={14} color={theme.colors.textSecondary} />
    </Pressable>;
}

const styles = StyleSheet.create((theme) => ({
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    label: { flex: 1, color: theme.colors.text, fontSize: 15 },
}));

export function ContinueSheet({ visible, sessionId, agentKind, sourceCwd, onClose }: {
    visible: boolean;
    sessionId: string;
    agentKind: string | undefined;
    sourceCwd: string | undefined;
    onClose: () => void;
}): React.JSX.Element {
    const router = useRouter();
    const auth = useAuth();
    const session = useSession(sessionId);
    const machines = useAllMachines({ includeOffline: true });
    const socket = useSocketStatus();
    const [grants, setGrants] = React.useState<StoredHostedGrant[]>([]);
    const [probes, setProbes] = React.useState<Record<string, { online: boolean; installed: boolean; ssh?: boolean }>>({});
    const [phase, setPhase] = React.useState<'pick' | 'writing' | 'preview' | 'starting'>('pick');
    const [picked, setPicked] = React.useState<{ grant: StoredHostedGrant; name: string; note: string; cwd: string; folder: string } | null>(null);
    const [failure, setFailure] = React.useState<string>();
    const [canRetry, setCanRetry] = React.useState(true);
    const generation = React.useRef(0);
    const sourceMachineId = getCachedConnectionSettings().machineId;
    const sourceMachine = machines.find((machine) => machine.id === sourceMachineId);

    React.useEffect(() => {
        if (!visible) return;
        const current = ++generation.current;
        setPhase('pick');
        setPicked(null);
        setFailure(undefined);
        setProbes({});
        void listPairedGrants().then((paired) => {
            if (generation.current !== current) return;
            setGrants(paired);
            for (const grant of paired) {
                if (grant.machineId === sourceMachineId) {
                    setProbes((value) => ({ ...value, [grant.machineId]: { online: true, installed: true } }));
                    continue;
                }
                void (async () => {
                    try {
                        const client = await openPairedMachine(grant);
                        try {
                            const kinds = await client.request('herdr.agentKinds', {});
                            if (generation.current === current) setProbes((value) => ({
                                ...value,
                                [grant.machineId]: { online: true, installed: agentKind !== undefined && (kinds.installed ?? []).includes(agentKind) },
                            }));
                        } finally { client.close(); }
                    } catch (cause) {
                        if (generation.current === current) setProbes((value) => ({ ...value, [grant.machineId]: { online: false, installed: false, ssh: cause instanceof SshComputerNeedsActivation } }));
                    }
                })();
            }
        }).catch((cause: unknown) => setFailure(message(cause)));
        return () => { generation.current++; };
    }, [visible, sourceMachineId, agentKind]);

    const rows = React.useMemo<ComputerRow[]>(() => grants.map((grant) => {
        const probe = probes[grant.machineId];
        const active = grant.machineId === sourceMachineId;
        const isOnline = active ? socket.status === 'connected' : probe?.online === true;
        const name = active ? 'This computer' : machines.find((machine) => machine.id === grant.machineId)?.metadata?.displayName?.trim()
            || grant.machineName?.trim() || 'Paired computer';
        return {
            id: grant.machineId,
            name,
            state: isOnline ? 'online' : active ? 'asleep' : probe?.ssh ? 'ssh' : 'offline',
            inUse: active || session?.metadata?.machineId === grant.machineId,
            checking: !active && probe === undefined,
            grant,
            disabledReason: probe?.ssh ? 'Switch to it in Computers first.' : probe?.online && !probe.installed ? `${agentKind ?? 'This agent'} is not installed there.` : undefined,
        };
    }), [agentKind, grants, machines, probes, session?.metadata?.machineId, socket.status, sourceMachineId]);

    const begin = async (row: ComputerRow) => {
        if (!row.grant || agentKind === undefined) return;
        const targetHome = machines.find((machine) => machine.id === row.id)?.metadata?.homeDir;
        const { cwd, folder } = mapHomePath(sourceCwd, sourceMachine?.metadata?.homeDir, targetHome);
        setPhase('writing');
        setFailure(undefined);
        setCanRetry(true);
        const current = generation.current;
        try {
            const { note } = await sync.request('session.handoff', { sessionId, targetName: row.name }, HANDOFF_TIMEOUT_MS);
            if (generation.current !== current) return;
            setPicked({ grant: row.grant, name: row.name, note, cwd, folder });
            setPhase('preview');
        } catch (cause) {
            if (generation.current !== current) return;
            setFailure(message(cause));
            setPhase('pick');
        }
    };

    const start = async () => {
        if (!picked || agentKind === undefined) return;
        setPhase('starting');
        setFailure(undefined);
        setCanRetry(true);
        let stage: 'connect' | 'start' | 'list' | 'prompt' | 'switch' = 'connect';
        let notice: string | undefined;
        const sourceName = sourceMachine?.metadata?.displayName ?? 'the previous computer';
        let client;
        try {
            client = await openPairedMachine(picked.grant);
            stage = 'start';
            setCanRetry(false);
            let cwd = picked.cwd;
            let folder = picked.folder;
            const taskTitle = typeof session?.metadata?.taskTitle === 'string' ? session.metadata.taskTitle : undefined;
            let started = await client.request('session.start', { cwd, kind: agentKind, label: taskTitle });
            if (started.acceptance?.outcome === 'failed' && started.acceptance.code === 'start-launch-failed' && started.acceptance.message.includes('cwd-does-not-exist')) {
                cwd = '~';
                folder = '~';
                started = await client.request('session.start', { cwd, kind: agentKind, label: taskTitle });
            }
            if (!('info' in started)) throw new Error(started.acceptance.message);
            let created: typeof started.info | undefined;
            stage = 'list';
            for (let attempt = 0; attempt < 10 && created === undefined; attempt += 1) {
                const sessions = await client.request('session.list', {});
                created = sessions.find((entry) => entry.id === started.info.id);
                if (created === undefined) await new Promise((resolve) => setTimeout(resolve, 300));
            }
            if (!created) throw new Error('The new agent did not appear on the other computer.');
            const header = `Continuing work from ${sourceName}, folder ${folder}${folder === '~' ? ' (the other computer’s home folder)' : ''}. This computer may not have the same files; check first.\n\n`;
            stage = 'prompt';
            await client.request('session.prompt', { sessionId: created.id, text: `${header}${picked.note}` }, PROMPT_TIMEOUT_MS);
            // The target holds the note now; retire the source over the still-active source link, before the switch.
            notice = await retireSource(sessionId, sourceName);
            stage = 'switch';
            const activated = await pairMachine({ grant: picked.grant });
            if (!activated.ok) throw new Error(activated.reason === 'failed' ? activated.message : 'Realtime voice is still pinned to another computer.');
            await auth.login(activated.credential, activated.secretKey);
            onClose();
            navigateToSession(router, created.id);
            if (notice !== undefined) Modal.alert(`Continued on ${picked.name}`, notice);
        } catch (cause) {
            const detail = message(cause);
            setFailure(stage === 'prompt'
                ? `Started on ${picked.name}, but the note was not delivered: ${detail} The work is still on ${sourceName}.`
                : stage === 'list'
                    ? `Started on ${picked.name}, but it did not appear in the computer's session list: ${detail} It may still be open there.`
                    : stage === 'switch'
                    ? `The note was delivered on ${picked.name}, but the app could not switch computers: ${detail} ${notice ?? `It was closed on ${sourceName}.`}`
                    : `Couldn't start on ${picked.name}: ${detail} The work is still on ${sourceName}.`);
            if (stage === 'list' || stage === 'prompt' || stage === 'switch') setCanRetry(false);
            setPhase('preview');
        } finally {
            client?.close();
        }
    };

    const body = phase === 'pick' ? (
        <View>
            <ComputerRows rows={rows} onPick={(row) => { void begin(row); }} />
            {failure !== undefined && <Text accessibilityRole="alert" style={{ color: '#ff6961', padding: 16 }}>{failure}</Text>}
        </View>
    ) : (
        <View style={{ padding: 20, gap: 14 }}>
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600' }}>{phase === 'writing' ? 'Writing a handoff note…' : phase === 'starting' ? `Starting on ${picked?.name}…` : `Continue on ${picked?.name}`}</Text>
            {phase === 'preview' && <Text selectable style={{ color: '#ddd', fontSize: 15, lineHeight: 22 }}>{picked?.note}</Text>}
            {failure !== undefined && <Text accessibilityRole="alert" style={{ color: '#ff6961' }}>{failure}</Text>}
            {phase === 'writing' && <Pressable onPress={onClose} accessibilityRole="button" style={{ minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff' }}>Cancel</Text></Pressable>}
            {phase === 'preview' && <View style={{ flexDirection: 'row', gap: 12 }}>
                {canRetry
                    ? <Pressable onPress={() => void start()} accessibilityRole="button" style={{ flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#4b86f5' }}><Text style={{ color: '#fff', fontWeight: '600' }}>{`Start on ${picked?.name}`}</Text></Pressable>
                    : <Pressable onPress={onClose} accessibilityRole="button" style={{ flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#4b86f5' }}><Text style={{ color: '#fff', fontWeight: '600' }}>Close</Text></Pressable>}
                {canRetry && <Pressable onPress={onClose} accessibilityRole="button" style={{ minHeight: 48, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff' }}>Cancel</Text></Pressable>}
            </View>}
        </View>
    );
    return <ScopedTheme name="dark"><OptionSheet visible={visible} title="Continue on another computer" options={[]} onSelect={() => undefined} onClose={onClose} maxWidth={560} body={body} /></ScopedTheme>;
}
