import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { OptionSheet } from '@/components/OptionSheet';
import { SheetIcon } from '@/components/SheetIcon';
import { useAuth } from '@/account/ui';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { useAllMachines, useSession } from '@/catalog/store';
import { openPairedMachine } from '@/collaboration';
import { pairMachine } from '@/pairing';
import { Modal } from '@/modal';
import { navigateToSession } from '../application/useNavigateToSession';
import { mapHomePath, retireSource } from '../application/retireSource';
import { moveToComputer, type MoveEndpoint, type MoveOutcome, type MoveStep } from '../application/moveToComputer';
import { useComputerRows } from '../application/useComputerRows';
import { ComputerRows, type ComputerRow } from './ComputersSheet';
import { ContinueRow } from './ContinueSheet';

const STEPS: Array<{ step: MoveStep; label: (to: string, sent: string) => string }> = [
    { step: 'checking', label: (to) => `Checking ${to}` },
    { step: 'packing', label: () => 'Packing the conversation' },
    { step: 'sending', label: (_to, sent) => `Sending${sent}` },
    { step: 'resuming', label: (to) => `Resuming on ${to}` },
];

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

type Phase = 'pick' | 'confirm' | 'moving' | 'done' | 'failed';
type Picked = { row: ComputerRow; name: string };

/**
 * The one row an agent's actions offer for sending it to another computer:
 * Move (same conversation) when its kind can move, otherwise the Continue note.
 */
export function MoveOrContinueRow({ sessionId, agentKind, onMove, onContinue }: {
    sessionId: string;
    agentKind: string | undefined;
    onMove: () => void;
    onContinue: () => void;
}): React.JSX.Element | null {
    const { theme } = useUnistyles();
    const [movable, setMovable] = React.useState(false);
    React.useEffect(() => {
        let live = true;
        setMovable(false);
        void sync.request('move.offer', { sessionId }).then((offer) => { if (live) setMovable(offer.movable); }).catch(() => undefined);
        return () => { live = false; };
    }, [sessionId]);
    if (!movable) return <ContinueRow agentKind={agentKind} onOpen={onContinue} />;
    return <Pressable onPress={onMove} accessibilityRole="button" accessibilityLabel="Move to another computer"
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }]}>
        <SheetIcon name="swap-horizontal-outline" size={18} color={theme.colors.textSecondary} />
        <Text style={styles.rowLabel}>Move to another computer</Text>
        <SheetIcon name="chevron-forward" size={14} color={theme.colors.textSecondary} />
    </Pressable>;
}

interface MoveSheetProps {
    visible: boolean;
    sessionId: string;
    agentKind: string | undefined;
    sourceCwd: string | undefined;
    onClose: () => void;
    /** Hand the person to the simpler Continue flow when a move cannot happen. */
    onContinue: () => void;
}

/**
 * No scoped theme: the sheet's own surface follows the app theme (a web sheet portals out of any
 * scope), so its text must read the same theme or it vanishes into the surface in light mode.
 */
export function MoveSheet({ visible, sessionId, agentKind, sourceCwd, onClose, onContinue }: MoveSheetProps): React.JSX.Element {
    const { theme } = useUnistyles();
    const router = useRouter();
    const auth = useAuth();
    const session = useSession(sessionId);
    const machines = useAllMachines({ includeOffline: true });
    const [phase, setPhase] = React.useState<Phase>('pick');
    const [picked, setPicked] = React.useState<Picked | null>(null);
    const [step, setStep] = React.useState<MoveStep>('checking');
    const [progress, setProgress] = React.useState<{ sent: number; total: number }>({ sent: 0, total: 0 });
    const [outcome, setOutcome] = React.useState<MoveOutcome | null>(null);
    const [notice, setNotice] = React.useState<string>();
    const cancelled = React.useRef(false);
    const generation = React.useRef(0);
    const sourceMachineId = getCachedConnectionSettings().machineId;
    const sourceMachine = machines.find((machine) => machine.id === sourceMachineId);
    const check = React.useCallback(async (client: Awaited<ReturnType<typeof openPairedMachine>>) => {
        if (agentKind === undefined) return 'This kind of agent keeps Continue.';
        const ready = await client.request('move.ready', { kind: agentKind });
        return ready.ready ? undefined : ready.message;
    }, [agentKind]);
    const { rows, failure: rowsFailure, sourceName } = useComputerRows({ visible, sessionId, check, switchable: true });

    React.useEffect(() => {
        if (!visible) return;
        ++generation.current;
        cancelled.current = false;
        setPhase('pick');
        setPicked(null);
        setOutcome(null);
        setNotice(undefined);
        return () => { generation.current++; };
    }, [visible]);

    const pick = (row: ComputerRow) => { setPicked({ row, name: row.name }); setPhase('confirm'); };

    const start = async () => {
        if (picked === null || picked.row.grant === undefined || agentKind === undefined) return;
        const { row, name } = picked;
        const grant = row.grant!;
        const current = generation.current;
        const viaSwitch = row.state === 'ssh';
        const sourceHome = sourceMachine?.metadata?.homeDir;
        cancelled.current = false;
        setPhase('moving');
        setOutcome(null);
        setProgress({ sent: 0, total: 0 });
        let client: Awaited<ReturnType<typeof openPairedMachine>> | undefined;
        const outcomeOf = await moveToComputer({
            source: ((type, params, timeoutMs) => sync.request(type, params, timeoutMs)) as MoveEndpoint,
            destination: async () => {
                if (viaSwitch) {
                    // The app reaches this computer only by switching to it, so the whole conversation is held here first.
                    const activated = await pairMachine({ grant });
                    if (!activated.ok) throw new Error(activated.reason === 'failed' ? activated.message : 'Realtime voice is still pinned to another computer.');
                    await auth.login(activated.credential, activated.secretKey);
                    return ((type, params, timeoutMs) => sync.request(type, params, timeoutMs)) as MoveEndpoint;
                }
                client = await openPairedMachine(grant);
                return ((type, params, timeoutMs) => client!.request(type, params, timeoutMs)) as MoveEndpoint;
            },
            buffered: viaSwitch,
            sessionId,
            kind: agentKind,
            destinationName: name,
            mapCwd: (cwd, destinationHome) => mapHomePath(cwd || sourceCwd, sourceHome, machines.find((machine) => machine.id === row.id)?.metadata?.homeDir ?? destinationHome).cwd,
            onStep: (next) => { if (generation.current === current) setStep(next); },
            onProgress: (sent, total) => { if (generation.current === current) setProgress({ sent, total }); },
            cancelled: () => cancelled.current || generation.current !== current,
        });
        client?.close();
        if (generation.current !== current) return;
        setOutcome(outcomeOf);
        setPhase(outcomeOf.ok ? 'done' : 'failed');
    };

    const open = async (closeSource: boolean) => {
        if (picked === null || picked.row.grant === undefined || outcome === null || !outcome.ok) return;
        const viaSwitch = picked.row.state === 'ssh';
        let note: string | undefined;
        if (closeSource && !viaSwitch) note = await retireSource(sessionId, sourceName);
        try {
            if (!viaSwitch) {
                const activated = await pairMachine({ grant: picked.row.grant });
                if (!activated.ok) throw new Error(activated.reason === 'failed' ? activated.message : 'Realtime voice is still pinned to another computer.');
                await auth.login(activated.credential, activated.secretKey);
            }
            onClose();
            navigateToSession(router, outcome.sessionId);
            if (note !== undefined) Modal.alert(`Moved to ${picked.name}`, note);
        } catch (cause) {
            setNotice(`Couldn't switch to ${picked.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    };

    const taskTitle = typeof session?.metadata?.taskTitle === 'string' ? session.metadata.taskTitle : undefined;
    const to = picked?.name ?? 'the other computer';
    const failed = outcome !== null && !outcome.ok ? outcome : undefined;
    const sent = progress.total > 0 ? ` ${megabytes(progress.total)}` : '';
    const viaSwitch = picked?.row.state === 'ssh';

    const agentLine = taskTitle ?? 'this agent';
    const onDestination = failed?.onDestination === true;
    const notReady = failed?.code === 'move-not-ready';
    // A refusal that no retry changes sends the person to Continue, which every kind keeps.
    const noRetry = failed?.code === 'move-unsupported' || failed?.code === 'move-too-large';
    const failedTitle = noRetry ? "This agent can't move" : onDestination ? `On ${to}, but it didn't start` : notReady ? `${to} can't take it yet` : failed?.stage === 'sending' ? 'The connection dropped' : "The move didn't finish";
    const strip = ((): [string, string, 'on' | 'off' | 'bad', 'on' | 'off' | 'bad'] => {
        if (phase === 'moving') return [`Still running, nothing changed`, progress.total > 0 && step === 'sending' ? `Receiving, ${megabytes(progress.sent)} of ${megabytes(progress.total)}` : 'Getting ready', 'on', 'off'];
        if (phase === 'done') return ['Still open, not running', `Running ${agentLine}`, 'off', 'on'];
        if (phase === 'failed') return [onDestination ? 'Untouched' : 'Still running', onDestination ? 'Has the conversation, not running' : notReady ? 'Not signed in' : noRetry ? 'Nothing moved' : 'Nothing imported', 'on', onDestination ? 'off' : 'bad'];
        return [`Running ${agentLine}`, picked === null ? 'Pick a computer' : 'Online, ready to receive', 'on', 'on'];
    })();
    const header = phase === 'pick' && picked === null ? null : (
        <View style={[styles.strip, styles.panelBg]}>
            <View style={styles.side}>
                <Text style={[styles.sideName, styles.ink]} numberOfLines={1}>{sourceName === 'the previous computer' ? 'This computer' : sourceName}</Text>
                <View style={styles.status}><View style={[styles.dot, { backgroundColor: strip[2] === 'on' ? theme.colors.success : theme.colors.textSecondary }]} /><Text style={[styles.statusText, styles.muted]}>{strip[0]}</Text></View>
            </View>
            <Ionicons name="arrow-forward" size={16} color={theme.colors.textSecondary} />
            <View style={styles.side}>
                <Text style={[styles.sideName, styles.ink]} numberOfLines={1}>{to}</Text>
                <View style={styles.status}><View style={[styles.dot, { backgroundColor: strip[3] === 'on' ? theme.colors.success : strip[3] === 'bad' ? theme.colors.textDestructive : theme.colors.textSecondary }]} /><Text style={[styles.statusText, styles.muted]}>{strip[1]}</Text></View>
            </View>
        </View>
    );
    const truth = (rows: Array<[string, string]>) => (
        <View style={[styles.group, styles.panelBg]}>
            {rows.map(([who, what]) => <View key={who} style={styles.truth}><Text style={[styles.truthWho, styles.ink]}>{who}</Text><Text style={[styles.truthWhat, styles.muted]}>{what}</Text></View>)}
        </View>
    );
    const list = (marker: 'checkmark' | 'remove', items: string[]) => (
        <View style={[styles.group, styles.panelBg]}>
            {items.map((item) => <View key={item} style={styles.listRow}><Ionicons name={marker} size={16} color={marker === 'checkmark' ? theme.colors.success : theme.colors.textSecondary} /><Text style={[styles.line, styles.ink, { flex: 1 }]}>{item}</Text></View>)}
        </View>
    );
    const button = (label: string, onPress: () => void, kind: 'primary' | 'secondary' | 'quiet' = 'primary', disabled = false) => (
        <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }}
            style={[kind === 'quiet' ? styles.quiet : styles.primary, kind === 'primary' && styles.accentBg, kind === 'primary' && disabled && styles.dimmed, kind === 'secondary' && styles.trackBg]}>
            <Text style={kind === 'primary' ? [styles.primaryText, styles.onAccent] : [styles.quietText, kind === 'secondary' ? styles.ink : styles.muted]}>{label}</Text>
        </Pressable>
    );

    let body: React.ReactNode;
    if (phase === 'pick') {
        body = (
            <View style={styles.panel}>
                {header}
                <Text style={[styles.note, styles.muted]}>Carries this conversation to the computer you pick.</Text>
                <ComputerRows rows={rows.map((row) => row.id === picked?.row.id ? { ...row, readiness: 'Selected' } : row)} onPick={(row) => setPicked({ row, name: row.name })} />
                {rowsFailure !== undefined && <Text accessibilityRole="alert" style={[styles.error, styles.danger]}>{rowsFailure}</Text>}
                <View style={styles.buttons}>
                    {button('Continue', () => setPhase('confirm'), 'primary', picked === null)}
                    {button('Cancel', onClose, 'quiet')}
                </View>
            </View>
        );
    } else if (phase === 'confirm') {
        body = (
            <View style={styles.panel}>
                {header}
                <Text style={[styles.section, styles.muted]}>What moves</Text>
                {list('checkmark', ['The whole conversation', 'The same folder, when it exists there'])}
                <Text style={[styles.section, styles.muted]}>What stays behind</Text>
                {list('remove', ['A running command or shell', 'Sign-ins and keys', 'Files outside the conversation'])}
                <Text style={[styles.note, styles.muted]}>{`${sourceName} keeps this conversation until ${to} has it running.${viaSwitch ? ` The app switches to ${to} to finish.` : ''}`}</Text>
                <View style={styles.buttons}>
                    {button(`Move to ${to}`, () => void start())}
                    {button('Back', () => setPhase('pick'), 'quiet')}
                </View>
            </View>
        );
    } else if (phase === 'moving') {
        const at = STEPS.findIndex((entry) => entry.step === step);
        body = (
            <View style={styles.panel}>
                {header}
                {STEPS.map((entry, index) => (
                    <View key={entry.step} style={styles.step} accessibilityLabel={`${entry.label(to, sent)}${index < at ? ', done' : index === at ? ', in progress' : ''}`}>
                        <Ionicons name={index < at ? 'checkmark-circle' : index === at ? 'radio-button-on' : 'ellipse-outline'} size={18}
                            color={index < at ? theme.colors.success : index === at ? theme.colors.text : theme.colors.textSecondary} />
                        <Text style={[styles.line, index > at ? styles.muted : styles.ink]}>{entry.label(to, sent)}</Text>
                    </View>
                ))}
                {step === 'sending' && progress.total > 0 && (
                    <View accessibilityLabel={`Sent ${megabytes(progress.sent)} of ${megabytes(progress.total)}`}>
                        <View style={[styles.track, styles.trackBg]}>
                            <View style={[styles.fill, styles.accentBg, { width: `${Math.round((progress.sent / progress.total) * 100)}%` }]} />
                        </View>
                        <View style={styles.meta}><Text style={[styles.note, styles.muted]}>{`${megabytes(progress.sent)} of ${megabytes(progress.total)} sent`}</Text><Text style={[styles.note, styles.muted]}>{`${Math.round((progress.sent / progress.total) * 100)}%`}</Text></View>
                    </View>
                )}
                <View style={styles.buttons}>
                    {button('Cancel', () => { cancelled.current = true; }, 'quiet')}
                    <Text style={[styles.note, styles.mutedCenter]}>{`Stops here; nothing changes on ${sourceName}.`}</Text>
                </View>
            </View>
        );
    } else if (phase === 'done') {
        body = (
            <View style={styles.panel}>
                {header}
                <Text style={[styles.note, styles.muted]}>{`The conversation carries on there. It is still open on ${sourceName} until you close it.`}</Text>
                {truth([[to, 'Has the whole conversation and is running it in a pane.'], [sourceName, 'Keeps its copy, open and idle, until you close it.']])}
                {notice !== undefined && <Text accessibilityRole="alert" style={[styles.error, styles.danger]}>{notice}</Text>}
                <View style={styles.buttons}>
                    {button(`Open on ${to}`, () => void open(false))}
                    {!viaSwitch && button(`Close on ${sourceName}`, () => void open(true), 'secondary')}
                </View>
            </View>
        );
    } else {
        body = (
            <View style={styles.panel}>
                {header}
                <Text accessibilityRole="alert" style={[styles.line, styles.ink]}>{failed?.message}</Text>
                {truth(onDestination
                    ? [[to, 'Has the conversation, but the agent did not start.'], [sourceName, 'Untouched.']]
                    : [[sourceName, 'Still running this agent, unchanged.'], [to, noRetry ? 'Nothing was moved.' : 'Nothing was imported.']])}
                <View style={styles.buttons}>
                    {onDestination && button(`Open ${to}`, () => void open(false))}
                    {!onDestination && !noRetry && button('Try again', () => void start())}
                    {!onDestination && button('Continue instead', () => { onClose(); onContinue(); }, noRetry ? 'primary' : 'secondary')}
                    {button(onDestination ? 'Close' : 'Cancel', onClose, 'quiet')}
                </View>
            </View>
        );
    }
    return <OptionSheet visible={visible} title={phase === 'confirm' ? `Move to ${to}?` : phase === 'moving' ? `Moving to ${to}` : phase === 'done' ? `Moved to ${to}` : phase === 'failed' ? failedTitle : 'Move to another computer'} options={[]} onSelect={() => undefined} onClose={onClose} maxWidth={560} body={body} />;
}

const styles = StyleSheet.create((theme) => ({
    ink: { color: theme.colors.text },
    muted: { color: theme.colors.textSecondary },
    mutedCenter: { color: theme.colors.textSecondary, textAlign: 'center' },
    danger: { color: theme.colors.textDestructive },
    onAccent: { color: theme.colors.surface },
    panelBg: { backgroundColor: theme.colors.surfaceHigh },
    trackBg: { backgroundColor: theme.colors.surfaceHighest },
    accentBg: { backgroundColor: theme.colors.accent },
    dimmed: { opacity: 0.4 },
    strip: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12 },
    side: { flex: 1, gap: 2 },
    sideName: { fontSize: 15, fontWeight: '600' },
    status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    statusText: { fontSize: 12, flexShrink: 1 },
    group: { borderRadius: 12, overflow: 'hidden' },
    listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
    truth: { paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
    truthWho: { fontSize: 14, fontWeight: '600' },
    truthWhat: { fontSize: 14, lineHeight: 20 },
    meta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    rowLabel: { flex: 1, color: theme.colors.text, fontSize: 15 },
    lede: { color: theme.colors.textSecondary, fontSize: 14, paddingHorizontal: 16, paddingBottom: 8 },
    panel: { padding: 20, gap: 12 },
    heading: { fontSize: 18, fontWeight: '600' },
    section: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4 },
    line: { fontSize: 15, lineHeight: 22 },
    note: { fontSize: 13, lineHeight: 19 },
    error: { fontSize: 14, padding: 16 },
    step: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 },
    track: { height: 4, borderRadius: 2, overflow: 'hidden' },
    fill: { height: 4, borderRadius: 2 },
    buttons: { gap: 4, marginTop: 8 },
    primary: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    primaryText: { fontSize: 16, fontWeight: '600' },
    quiet: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    quietText: { fontSize: 15 },
}));
