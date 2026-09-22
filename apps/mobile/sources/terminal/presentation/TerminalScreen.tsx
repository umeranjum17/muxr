/**
 * The session screen: a live terminal, not a transcript.
 *
 * Herdr backs every agent CLI, so there is no per-agent transcript to render --
 * what the agent draws is what you see, and the keys you would press at the desk
 * are the ones the toolbar sends. Approvals happen in the terminal itself.
 */

import { RealtimeTalkButton } from '@/conversation/ui';
import * as React from 'react';
import { ActivityIndicator, AppState, BackHandler, InteractionManager, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, ReduceMotion, useAnimatedStyle, useReducedMotion, type SharedValue } from 'react-native-reanimated';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { changesList } from '@/catalog/ops';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { storage, useHerdrTree, useLocalSettingMutable, useSession, useSessionGitStatus, useSessions, useSocketStatus } from '@/catalog/store';
import { sessionStop } from '@/catalog/ops';
import { registerArtifactUpdateHandler, sync } from '@/catalog/sync';
import { resolveMessageModeMeta } from '@/catalog';
import { recordAgentGate, recordTrackedRpc } from '@/catalog/diagnostics';
import { permissionModeChip, resolveStatusBarGitBranch } from '../domain/sessionStatusBar';
import { PaneOverviewSheet, SessionMetaLine, WorkspaceTreeSheet } from '@/herd/ui';
import type { HerdrTreeTab } from '@muxr/contract';
import { TerminalView, type TerminalViewControls } from './TerminalView';
import { usePaneGestures } from '../application/usePaneGestures';
import { AgentGlyph } from '@/components/AgentGlyph';
import { AnimatedPopup } from '@/components/AnimatedOverlay';
import { agentLabels, agentNameLine, agentStatusColor, HERD_STATUS_LABELS, herdrPaneForSession, herdrTabForSession, isShellLabels, rememberPaneSelection, resolveTabPane, tabLabel, useNavigateToSession } from '@/herd';
import {
    DIALOG_GUARD_ACTION,
    DIALOG_GUARD_MESSAGE,
    DIALOG_GUARD_TITLE,
    terminalInputDisposition,
    terminalPaneCanSend,
    terminalPaneStatus,
} from '../domain/promptAvailability';
import type { TerminalChannel } from '../application/OpenTerminal';
import { useImagePicker } from '@/hooks/useImagePicker';
import { useDraft } from '@/hooks/useDraft';
import { ComposerAttachments, type ComposerAttachment } from '@/components/ComposerAttachments';
import { withAlpha } from '@/components/ui';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';
import { nextWorkingAgentId, workingAgentSwipeIds } from '@/herd';
import { useSessionPlugins } from '@/plugins';
import { PluginSlot, DeclarativeSessionActions, useDeclarativeSessionActions, DeclarativeTerminalKeySlot } from '@/plugins/ui';
import { useSlotContributions } from '@/plugins';
import type { SessionMenu } from '@/plugins';
import { FloatingTerminalControls, RING_CENTER_SIZE, type RingSlot } from './FloatingTerminalControls';
import { TERMINAL_QUICK_REPLIES, TerminalKeyRow } from './TerminalKeyRow';
import { TerminalControlGrid, type ControlGridCategory } from './TerminalKeyRowEditor';
import { DEFAULT_ROW_IDS, type RowEntry, type TerminalKeyAction } from '../domain/keyRow';
import { appendToDraft, clearDraftInsertion, consumeDraftInsertion } from '../application/draftInsertion';
import { recentTerminalLinks } from '../application/recentOutput';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { resolvePluginText } from '@/plugins';
import { randomUUID } from 'expo-crypto';
import { useDeviceAuthority } from '@/pairing';
import { useIsFocused } from '@react-navigation/native';
import { ActiveAgentWakeLock } from './ActiveAgentWakeLock';
import { useDictation } from '@/utils/dictation';
import { getCachedConnectionSettings } from '@/connection';
import { displayLink } from '../domain/TerminalLink';
import { humanError } from '@/utils/errors';
import { CommandPalette } from '@/components/CommandPalette';
import type { Command } from '@/components/CommandPalette/types';
import { CUSTOM_CATEGORY } from '@/components/CommandPalette/types';
import { agentCommands, type AgentCommand } from '../domain/agentCommands';
import { agentKindLabel } from '@/herd';
import { t } from '@/text';
import { FindOutputSheet } from './FindOutputSheet';
import { useTerminalQuickReplies } from '@/plugins/ui';

/** What a reply row's primary tap really does, for replies that never send. */
const INSERT_ONLY_LABEL = 'Inserts into the prompt, never sends.';

/**
 * How long a pane may show nothing but the connecting pill before it hands the
 * user the retry. The copy states where the pane is rather than declaring it
 * dead, because an attach still inside its own request timeouts may yet land --
 * and when it does it publishes its own state over this one.
 */
const CONNECT_DEADLINE_MS = 12_000;
const CONNECT_STALLED = 'still connecting';

/**
 * How long a pane must be unwell before it says so. A dropped link is noticed
 * within a couple of hundred milliseconds and most are back before anyone could
 * read a badge, so announcing instantly puts a notice over a terminal that is
 * about to be fine -- which is what a reconnect that interrupts nothing looks
 * like from the outside. Recovery is never delayed by this: going back to live
 * shows at once, so the badge only ever appears when the trouble outlasted it.
 */
const STATUS_GRACE_MS = 900;

// Live recording level as five honest bars; the same fixed weights keep every
// bar following the real input level, taller through the middle. The level is
// a shared value read on the UI thread, so a recording chunk never re-renders
// the screen around the bars.
const BAR_WEIGHTS = [0.45, 0.7, 1, 0.7, 0.45];
function DictationBars({ level, color }: { level: SharedValue<number>; color: string }) {
    return <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 10 }}>
        {BAR_WEIGHTS.map((weight, index) => (
            <DictationBar key={index} level={level} weight={weight} color={color} first={index === 0} />
        ))}
    </View>;
}

function DictationBar({ level, weight, color, first }: { level: SharedValue<number>; weight: number; color: string; first: boolean }) {
    const bar = useAnimatedStyle(() => ({ height: 4 + level.value * 11 * weight }));
    return <Animated.View style={[{ width: 2.5, borderRadius: 1.25, backgroundColor: color, marginLeft: first ? 0 : 3 }, bar]} />;
}

/** The restrained resolving state: three dots that breathe while text lands. */
function TranscribingDots({ color }: { color: string }) {
    const reduceMotion = useReducedMotion();
    const [phase, setPhase] = React.useState(0);
    React.useEffect(() => {
        if (reduceMotion === true) return;
        const timer = setInterval(() => setPhase((current) => (current + 1) % 3), 380);
        return () => clearInterval(timer);
    }, [reduceMotion]);
    return <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 10 }}>
        {[0, 1, 2].map((index) => (
            <View key={index} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color, opacity: reduceMotion === true ? 0.6 : phase === index ? 1 : 0.35, marginLeft: index === 0 ? 0 : 3 }} />
        ))}
    </View>;
}

/**
 * The session is one dark surface: the terminal paints dark whatever the app
 * theme, so everything around it -- header, strip, composer, keys, Tools and
 * every sheet they open -- reads the dark theme too. The scope sits at this
 * screen's own render root and the theme is read beneath it, so each render
 * of the screen (and everything it mounts) paints from the same palette.
 */
// The canvas black is the Ghostty background itself: chrome painted in any
// other value shows up as a band against the terminal.
const CANVAS_BLACK = '#0c0c0b';
function DarkSurface({ children }: { children: (theme: ReturnType<typeof useUnistyles>['theme']) => React.ReactNode }): React.JSX.Element {
    const { theme } = useUnistyles();
    return <>{children(theme)}</>;
}

export const TerminalScreen = React.memo((props: { id: string }) => {
    const { width: windowWidth } = useWindowDimensions();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const isFocused = useIsFocused();
    const socketStatus = useSocketStatus();
    const [appActive, setAppActive] = React.useState(Platform.OS === 'web' || AppState.currentState === 'active');
    const keepScreenAwake = useLocalSettingMutable('keepScreenAwakeWhileWatching')[0];
    const canControl = authority === 'control' && !authorityLoading;
    const insets = useSafeAreaInsets();
    // Keyboard height already covers the home indicator, so keeping the bottom
    // inset while it is up double-pads the composer.
    const keyboardVisible = useKeyboardState().isVisible;
    const keyboardHeight = useKeyboardState().height;
    const session = useSession(props.id);
    const sessions = useSessions();
    const { workspaces, loaded: treeLoaded } = useHerdrTree();
    const storedPane = herdrPaneForSession(workspaces, props.id);
    const gitStatus = useSessionGitStatus(props.id);
    const pluginButtons = useSessionPlugins();
    const declaredActions = useDeclarativeSessionActions(session?.metadata?.path);
    const pluginQuickReplies = useTerminalQuickReplies();
    const quickReplies = React.useMemo(() => [...TERMINAL_QUICK_REPLIES, ...pluginQuickReplies], [pluginQuickReplies]);
    const [changesCount, setChangesCount] = React.useState<number | null>(null);
    const [artifactsCount, setArtifactsCount] = React.useState<number | null>(null);
    useFocusEffect(React.useCallback(() => {
        let cancelled = false;
        changesList(props.id)
            .then((badge) => { if (!cancelled) setChangesCount(badge.count); })
            .catch(() => { if (!cancelled) setChangesCount(null); });
        // The artifact count is a badge; the terminal is why this screen was
        // opened. Asking the host to enumerate a pane's whole history while it
        // is still answering this pane's attach put a directory walk in front
        // of the first frame, so it waits until the open has settled.
        const counting = InteractionManager.runAfterInteractions(() => {
            if (cancelled) return;
            sync.artifactList(props.id)
                .then((result) => { if (!cancelled) setArtifactsCount(result.total); })
                .catch(() => { if (!cancelled) setArtifactsCount(null); });
        });
        const unsubscribe = registerArtifactUpdateHandler((sessionId, event) => {
            if (!cancelled && sessionId === props.id) setArtifactsCount(event.total);
        });
        return () => { cancelled = true; counting.cancel(); unsubscribe(); };
    }, [props.id]));
    const [terminalKeyboardDisabled, setTerminalKeyboardDisabled] = useLocalSettingMutable('terminalKeyboardDisabled');
    const [pluginActionBusy, setExtensionActionBusy] = React.useState<string>();
    const [swipeNow, setSwipeNow] = React.useState(Date.now);
    React.useEffect(() => {
        const timer = setInterval(() => setSwipeNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);
    const swipeIds = React.useMemo(() => workingAgentSwipeIds(sessions, swipeNow), [sessions, swipeNow]);
    const [status, setStatus] = React.useState('connecting');
    // A fresh mount is the only retry a pane has before it ever attached: the
    // channel that reconnect() would use does not exist yet.
    const [attempt, setAttempt] = React.useState(0);
    const [draft, setDraft] = React.useState('');
    const { clearDraft } = useDraft(props.id, draft, setDraft);
    const [attaching, setAttaching] = React.useState(false);
    const [stopping, setStopping] = React.useState(false);
    // Latching modifiers apply to one toolbar key or typed character, then clear.
    // Modal.alert lays buttons out in a row: past three it collapses into
    // overlapping mush on a phone. Anything with more options uses this sheet.
    const [menu, setMenu] = React.useState<SessionMenu | null>(null);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    const [findOpen, setFindOpen] = React.useState(false);
    const [controlGrid, setControlGrid] = React.useState<{ open: boolean; category: ControlGridCategory }>({ open: false, category: 'keys' });
    const [personalReplies, setPersonalReplies] = useLocalSettingMutable('terminalQuickReplies');
    const [rowEntries, setRowEntries] = useLocalSettingMutable('terminalKeyRow');
    const rowSeed = React.useMemo<RowEntry[]>(() => rowEntries ?? [...DEFAULT_ROW_IDS], [rowEntries]);
    // Focus in Herdr: one request, the menu stays open while it is pending,
    // a failure stays on the row until the next tap; nothing replays itself.
    const [focusPending, setFocusPending] = React.useState(false);
    const [focusFailure, setFocusFailure] = React.useState<string | null>(null);
    const [headerBottom, setHeaderBottom] = React.useState(0);
    // View commands keep a permanent route in Pane actions.
    const [viewControls, setViewControls] = React.useState<TerminalViewControls>({ commands: [], dismissKeyboard: () => {} });
    const [terminalBox, setTerminalBox] = React.useState<{ top: number; width: number; height: number }>();
    // The ring is hosted by the screen, never by the terminal renderer.
    const [toolsOpen, setToolsOpen] = React.useState(false);
    const [attachedImages, setAttachedImages] = React.useState<ComposerAttachment[]>([]);
    const attachedPaths = attachedImages.flatMap((image) => image.path === undefined ? [] : [image.path]);
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const [channel, setChannel] = React.useState<TerminalChannel>();
    const draftRef = React.useRef(draft);
    const composerRef = React.useRef<TextInput>(null);
    draftRef.current = draft;
    // Dictation lives in the composer rail itself: one pill that reads
    // Dictating… then Transcribing…, then commits into the editable draft.
    // The terminal owns the transcript, so it never renders a second copy.
    const dictation = useDictation(() => draftRef.current, setDraft);
    const dictationActive = dictation.recording || dictation.transcribing;
    React.useEffect(() => { if (dictation.pending !== null) dictation.accept(); }, [dictation.pending, dictation.accept]);
    // The ring's docked centre is measured from the composer rail so the ring
    // blooms over the terminal from exactly where the thumb rests.
    const ringSlotRef = React.useRef<View>(null);
    // The overlay that draws the centre is positioned in this screen's own
    // layout space, so the slot has to be measured in that space too.
    // measureInWindow answers in window coordinates, and on Android those
    // leave the status bar out while the screen's layout counts it: the two
    // differed by exactly insets.top and the control drew a row above the rail
    // it is docked in. measureLayout against the screen root has no such seam.
    const screenRef = React.useRef<View>(null);
    const [ringCenter, setRingCenter] = React.useState<{ x: number; y: number } | undefined>(undefined);
    const measureRingAnchor = React.useCallback(() => {
        const slot = ringSlotRef.current;
        const root = screenRef.current;
        if (slot === null || root === null) return;
        slot.measureLayout(root, (x, y, w, h) => {
            if (w === 0 && h === 0) return;
            setRingCenter((current) => (current !== undefined && Math.abs(current.x - (x + w / 2)) < 0.5 && Math.abs(current.y - (y + h / 2)) < 0.5 ? current : { x: x + w / 2, y: y + h / 2 }));
        }, () => undefined);
    }, []);
    React.useEffect(() => { measureRingAnchor(); }, [measureRingAnchor, keyboardVisible, keyboardHeight, terminalBox]);
    // The ring is drawn by an overlay onto the rail's reserved slot, so it may
    // only exist while that slot does. Dictation and a typed draft both take
    // the slot back, and a stale measurement would otherwise leave the centre
    // control floating over the capsule it just made way for.
    const railShowsRing = canControl && !dictationActive && draft === '';
    React.useEffect(() => { if (!railShowsRing) setToolsOpen(false); }, [railShowsRing]);
    const insertDraft = React.useCallback((value: string) => {
        const next = appendToDraft(draftRef.current, value);
        draftRef.current = next;
        setDraft(next);
        // The palette animates out; focus once its input has released the IME.
        setTimeout(() => composerRef.current?.focus(), 280);
    }, []);

    const { selectedImages, pickImages, clearImages } = useImagePicker();

    /**
     * How far herdr's viewport sits above the live edge, as herdr reports it.
     * Where herdr owns scrollback this is authoritative and the request counter
     * below is never consulted.
     */
    const scrollBack = React.useRef(0);
    const hostHasScrollback = React.useRef(false);
    /**
     * The old counting behaviour, retained only for alternate-screen panes:
     * there herdr reports maxOffsetFromBottom 0 no matter what the finger did,
     * so nothing else can know a program's own scroll position. A program that
     * ignores wheel reports entirely (measured: Claude Code and opencode return
     * no redraw to SGR wheel-up) will therefore show a control that cannot move
     * it -- accepted as the lesser harm than stranding someone inside vim or
     * less with mouse reporting on, which do respond to those reports.
     */
    const altBack = React.useRef(0);
    const [showJump, setShowJump] = React.useState(false);
    const stopWatchingChannel = React.useRef<(() => void) | undefined>(undefined);
    React.useEffect(() => () => stopWatchingChannel.current?.(), []);

    const onChannel = React.useCallback((channel: TerminalChannel | undefined) => {
        stopWatchingChannel.current?.();
        stopWatchingChannel.current = undefined;
        scrollBack.current = 0;
        hostHasScrollback.current = false;
        altBack.current = 0;
        if (channel !== undefined) {
            setShowJump(false);
            const stopScrollState = channel.onScrollState(({ offsetFromBottom, maxOffsetFromBottom }) => {
                if (maxOffsetFromBottom > 0) {
                    hostHasScrollback.current = true;
                    scrollBack.current = offsetFromBottom;
                    altBack.current = 0;
                    setShowJump(offsetFromBottom > 0);
                } else {
                    if (hostHasScrollback.current) altBack.current = 0;
                    hostHasScrollback.current = false;
                    scrollBack.current = 0;
                    setShowJump(altBack.current > 0);
                }
            });
            const rawScroll = channel.scroll.bind(channel);
            channel.scroll = (lines, at) => {
                if (!hostHasScrollback.current) {
                    altBack.current = Math.max(0, altBack.current + lines);
                    setShowJump(altBack.current > 0);
                }
                rawScroll(lines, at);
            };
            stopWatchingChannel.current = stopScrollState;
        }
        channelRef.current = channel;
        setChannel(channel);
    }, []);
    const jumpToBottom = React.useCallback(() => {
        const channel = channelRef.current;
        if (channel === undefined) return;
        if (hostHasScrollback.current) {
            // Exactly the distance herdr reported, not an overshoot: a pane whose
            // scrolling belongs to a program would receive that overshoot as
            // thousands of wheel reports rather than as a clamp. The control
            // stays until herdr confirms the viewport reached zero, because new
            // output behind a parked viewport moves the live edge away.
            if (scrollBack.current > 0) channel.scroll(-scrollBack.current);
            return;
        }
        let remaining = altBack.current;
        if (remaining <= 0) return;
        while (remaining > 0) {
            const step = Math.min(remaining, 400);
            channel.scroll(-step);
            remaining -= step;
        }
        altBack.current = 0;
        setShowJump(false);
    }, []);
    const showDialogMessage = React.useCallback(() => {
        if (channelRef.current === undefined) {
            router.push(`/session/${encodeURIComponent(props.id)}/history`);
            return;
        }
        jumpToBottom();
    }, [jumpToBottom, props.id]);
    const showDialogGuard = React.useCallback(() => {
        Modal.alert(DIALOG_GUARD_TITLE, DIALOG_GUARD_MESSAGE, [
            { text: DIALOG_GUARD_ACTION, onPress: showDialogMessage },
            { text: 'Dismiss', style: 'cancel' },
        ]);
    }, [showDialogMessage]);

    // One horizontal swipe pages through active agents and agents that finished
    // in the last two minutes. Old shells never sit between live work.
    const paneGestures = usePaneGestures({
        onAgentSwipe: (direction) => {
            const next = nextWorkingAgentId(swipeIds, props.id, direction === 'next' ? 1 : -1);
            if (next === undefined) {
                showGestureHint('No other working or recently finished agent');
                return;
            }
            router.replace(`/session/${encodeURIComponent(next)}`);
        },
    });

    // What the pane shows, as opposed to what it knows. The status itself stays
    // exact for everything that acts on it; only the announcement waits.
    const [shownStatus, setShownStatus] = React.useState(status);
    React.useEffect(() => {
        if (status === 'live') { setShownStatus('live'); return; }
        const timer = setTimeout(() => setShownStatus(status), STATUS_GRACE_MS);
        return () => clearTimeout(timer);
    }, [status]);

    // 'connecting' is the one status nothing is watching. The renderer opens
    // the channel only once it reports a grid, so a surface that never reports
    // one never starts the attach whose failure would move this status, and no
    // request timeout is running to end it either. A pane that has not started
    // by now says so and offers the retry, instead of holding a spinner over an
    // empty body for ever; a slow attach that does land overwrites this itself.
    React.useEffect(() => {
        if (status !== 'connecting') return;
        const timer = setTimeout(() => setStatus(CONNECT_STALLED), CONNECT_DEADLINE_MS);
        return () => clearTimeout(timer);
    }, [status, attempt]);

    // Before the first attach there is no channel to reconnect, so the retry a
    // stalled pane offers is a fresh mount of the renderer itself.
    const retryTerminal = React.useCallback(() => {
        const channel = channelRef.current;
        if (channel !== undefined) {
            channel.reconnect(true);
            return;
        }
        setStatus('connecting');
        setAttempt((current) => current + 1);
    }, []);

    // herdr is truth: a closed pane disappears. The ref guard is what stops a
    // status batch from double-firing: two 'unknown session' updates arriving
    // before a re-render would both pass a state check, producing two alerts
    // and two router.back() calls (the second pops an extra screen).
    const goneRef = React.useRef(false);
    const onStatus = React.useCallback(
        (next: string) => {
            setStatus(next);
            if (!goneRef.current && next.includes('unknown session')) {
                goneRef.current = true;
                clearDraftInsertion(props.id);
                storage.getState().deleteSession(props.id);
                Modal.alert('Session no longer exists', 'The host closed this session, so it was removed from your list.');
                router.back();
            }
        },
        [props.id],
    );

    // The header counts and the strip switches from the live tree, the same
    // store the sidebar and the pane overview read; nothing here fetches its
    // own copy. One refresh on focus keeps a long-open session current.
    const located = herdrTabForSession(workspaces, props.id);
    const currentTab = located?.tab;
    const workspaceTabs = located?.workspace.tabs ?? [];
    const siblings = React.useMemo(
        () => (currentTab?.panes ?? []).map((pane) => pane.sessionId).filter((id): id is string => id !== undefined),
        [currentTab],
    );
    const [overviewOpen, setOverviewOpen] = React.useState(false);
    const currentPane = storedPane;
    const sessionRef = React.useRef(session);
    sessionRef.current = session;
    const currentPaneRef = React.useRef(currentPane);
    currentPaneRef.current = currentPane;

    // One-shot consumption of a pick made elsewhere (history's "Insert into
    // prompt"): the handoff is keyed by session and pane, so a pick only
    // lands when this very pane is back in focus, and only once. The stored
    // draft may be re-loading into an empty local value on this same focus,
    // so the pick appends to what is about to be visible, never past it.
    React.useEffect(() => {
        if (!isFocused) return;
        const paneId = currentPane?.paneId;
        if (paneId === undefined) return;
        const text = consumeDraftInsertion(props.id, paneId);
        if (text === null) return;
        if (draftRef.current === '') {
            const stored = storage.getState().sessions[props.id]?.draft;
            if (stored !== undefined && stored !== null && stored !== '') draftRef.current = stored;
        }
        insertDraft(text);
    }, [currentPane?.paneId, insertDraft, isFocused, props.id]);

    // Rail actions: paste reads the clipboard only on this press and stops at
    // the draft; hide dismisses the keyboard now and persists nothing. Both
    // are draft-side, so neither can emit PTY bytes.
    const pasteToDraft = React.useCallback(async () => {
        let text: string | null;
        try {
            text = await Clipboard.getStringAsync();
        } catch {
            return; // clipboard denied: stay quiet
        }
        if (text === null || text === '') return;
        insertDraft(text);
    }, [insertDraft]);
    const hideKeyboardNow = React.useCallback(() => {
        if (!keyboardVisible) return;
        viewControls.dismissKeyboard();
        Keyboard.dismiss();
    }, [keyboardVisible, viewControls]);
    const onKeyAction = React.useCallback((action: TerminalKeyAction) => {
        if (action === 'paste') void pasteToDraft();
        else hideKeyboardNow();
    }, [hideKeyboardNow, pasteToDraft]);
    const showGestureHintRef = React.useRef<(text: string) => void>(() => undefined);
    const navigateToSession = useNavigateToSession();
    const tabStripRef = React.useRef<ScrollView>(null);
    const activeChipX = React.useRef(0);
    // The plugin tree sheet still mounts from the session header: the pane
    // overview answers "where am I", the overlay answers "what is around
    // me". Different header controls open each one.
    const [treeOpen, setTreeOpen] = React.useState(false);
    // A sheet or editor owns the screen; no floating control remains beneath it.
    React.useEffect(() => {
        if (actionsOpen || overviewOpen || treeOpen || findOpen || controlGrid.open || menu !== null) setToolsOpen(false);
    }, [actionsOpen, overviewOpen, treeOpen, findOpen, controlGrid.open, menu]);
    const editKeys = React.useCallback(() => { setToolsOpen(false); setActionsOpen(false); setControlGrid({ open: true, category: 'keys' }); }, []);
    const overlayContributions = useSlotContributions('session.overlay');
    // The composer slot is one icon, and an unlabelled icon dropped into a list
    // of labelled rows reads as something broken rather than something offered.
    // The contribution already names itself for assistive tech; the row shows
    // that same name.
    const composerContributions = useSlotContributions('session.composer.trailing');
    const composerSlotLabel = composerContributions.length === 1 && composerContributions[0]?.type === 'native' && composerContributions[0].accessibilityLabel !== undefined
        ? resolvePluginText(composerContributions[0].accessibilityLabel)
        : undefined;
    // The workspace tree is product and always opens from the header;
    // third-party overlays mount beside it when they contribute.
    const overlayLabel = overlayContributions[0]?.type === 'native' && overlayContributions[0].title !== undefined
        ? resolvePluginText(overlayContributions[0].title)
        : 'Workspace';
    // A tab tap goes straight to a pane; a tab with nothing to open yet asks
    // the tree again instead of guessing.
    const openTab = React.useCallback((tab: HerdrTreeTab) => {
        if (located === undefined) return;
        const target = resolveTabPane(tab, { machineId: getCachedConnectionSettings().machineId, workspaceId: located.workspace.workspaceId });
        if (target === undefined) {
            showGestureHintRef.current('Unavailable');
            void sync.refreshHerdTree().catch(() => undefined);
            return;
        }
        navigateToSession(target);
    }, [located, navigateToSession]);
    // Remember the pane this device is on, so its tab returns here.
    React.useEffect(() => {
        if (located === undefined) return;
        rememberPaneSelection({ machineId: getCachedConnectionSettings().machineId, workspaceId: located.workspace.workspaceId, tabId: located.tab.tabId }, props.id);
    }, [located, props.id]);
    // The active chip comes into view without reordering the strip.
    React.useEffect(() => {
        const timer = setTimeout(() => tabStripRef.current?.scrollTo({ x: Math.max(0, activeChipX.current - 48), animated: false }), 0);
        return () => clearTimeout(timer);
    }, [currentTab?.tabId, workspaceTabs.length]);
    React.useEffect(() => {
        if (!isFocused || session === null || currentPane === undefined || socketStatus.status !== 'connected') return;
        const machineId = getCachedConnectionSettings().machineId;
        if (!machineId) return;
        const previous = storage.getState().localSettings.lastTerminal;
        if (previous?.machineId === machineId && previous.sessionId === props.id) return;
        storage.getState().applyLocalSettings({ lastTerminal: { machineId, sessionId: props.id } });
    }, [currentPane, isFocused, props.id, session, socketStatus.status]);
    const panePromptable = currentPane?.promptable === true;
    const paneKind = currentPane?.agentKind;
    const paneLifecycle = currentPane?.agentStatus;
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (next) => setAppActive(next === 'active'));
        return () => subscription.remove();
    }, []);
    const watchingWorkingAgent = keepScreenAwake && isFocused && appActive
        && socketStatus.status === 'connected' && status === 'live'
        && paneLifecycle === 'working';
    const paneMissing = currentPane === undefined || isShellLabels(agentLabels(currentPane));
    const sendCommand = React.useCallback((command: string) => {
        if (currentPaneRef.current?.agentKind === undefined) {
            showGestureHintRef.current('No agent in this pane');
            return;
        }
        const disposition = terminalInputDisposition(currentPaneRef.current, sessionRef.current ?? undefined, command);
        if (disposition.kind === 'blocked') {
            showDialogGuard();
            return;
        }
        const request = disposition.kind === 'answer'
            ? sync.request('session.answer', { sessionId: props.id, answer: disposition.answer })
            : sync.sendMessage(props.id, command);
        void request.catch((error: unknown) => Modal.alert('Command failed', error instanceof Error ? error.message : String(error)));
    }, [props.id, showDialogGuard]);
    const openAgentCommands = React.useCallback(() => {
        if (!canControl) return;
        setToolsOpen(false);
        setActionsOpen(false);
        if (terminalInputDisposition(currentPaneRef.current, sessionRef.current ?? undefined, '/model').kind === 'blocked') {
            showDialogGuard();
            return;
        }
        const known = agentCommands(paneKind);
        const kindLabel = agentKindLabel(paneKind) ?? paneKind;
        const sendDangerous = async (entry: AgentCommand) => {
            const ok = await Modal.confirm(`Send ${entry.command}?`, `${entry.description}.${entry.reversible === true ? '' : ' This discards the current context.'}`, {
                confirmText: `Send ${entry.command}`,
                destructive: true,
            });
            // Cancelling resolves false so the palette stays open beneath the dialog.
            if (!ok) return false;
            showGestureHintRef.current(t('commandPalette.sent', { command: entry.command }));
            sendCommand(entry.command);
            return true;
        };
        const toEntry = (entry: AgentCommand, category: string): Command => ({
            id: entry.command,
            title: entry.command,
            hint: entry.arguments,
            subtitle: entry.description,
            destructive: entry.dangerous === true || undefined,
            category,
            action: entry.dangerous === true
                ? () => sendDangerous(entry)
                : () => {
                    showGestureHintRef.current(t('commandPalette.sent', { command: entry.command }));
                    sendCommand(entry.command);
                },
            secondaryAction: () => insertDraft(`${entry.command} `),
        });
        const entries: Command[] = [
            // Common replies live in the slash catalogue, at the top, so the
            // canned prompts have one home with the commands (report §8). A
            // reply is a promise that something is sent: the app's own replies
            // send; host-contributed ones still land in the draft for review,
            // as they always have.
            ...quickReplies.map((reply, index): Command => {
                const firstParty = index < TERMINAL_QUICK_REPLIES.length;
                return {
                    id: `reply:${index}:${reply.label}`,
                    title: reply.label,
                    category: t('commandPalette.commonReplies'),
                    action: firstParty
                        ? () => {
                            showGestureHintRef.current(t('commandPalette.sent', { command: reply.label }));
                            sendCommand(reply.text);
                        }
                        : () => insertDraft(reply.text),
                    // A host-contributed reply only ever lands in the draft, so
                    // the row must not announce that it sends.
                    actionLabel: firstParty ? undefined : INSERT_ONLY_LABEL,
                    secondaryAction: () => insertDraft(reply.text),
                };
            }),
            // Personal replies are insert-only: a tap lands in the visible
            // draft and only an explicit Send sends anything.
            ...personalReplies.map((reply): Command => ({
                id: `reply:user:${reply.id}`,
                title: reply.label,
                category: t('commandPalette.commonReplies'),
                action: () => insertDraft(reply.text),
                actionLabel: INSERT_ONLY_LABEL,
                secondaryAction: () => insertDraft(reply.text),
            })),
            ...known.filter((entry) => entry.common === true && entry.dangerous !== true).map((entry) => toEntry(entry, t('commandPalette.common'))),
            ...known.filter((entry) => entry.common !== true && entry.dangerous !== true).map((entry) => toEntry(entry, t('commandPalette.allCommands', { kind: kindLabel ?? '' }))),
            ...known.filter((entry) => entry.dangerous === true).map((entry) => toEntry(entry, t('commandPalette.destructive'))),
        ];
        entries.push({
            id: 'custom-command', title: t('commandPalette.typeCommand'), subtitle: t('commandPalette.insertSlash'),
            category: CUSTOM_CATEGORY, action: () => insertDraft('/'),
        });
        Modal.show({ component: CommandPalette, props: {
            appearance: 'terminal',
            title: known.length > 0 ? t('commandPalette.agentCommands', { agent: kindLabel ?? '' }) : t('commandPalette.commandsTitle'),
            quietLine: known.length > 0 ? undefined : t('commandPalette.noCatalogue', { kind: paneKind ?? t('commandPalette.thisAgent') }),
            commands: entries,
        } } as any);
    }, [canControl, insertDraft, paneKind, personalReplies, quickReplies, sendCommand, showDialogGuard]);
    React.useEffect(() => {
        if (paneMissing) {
            recordAgentGate({
                ...(paneKind === undefined ? {} : { kind: paneKind }),
                lifecycle: paneLifecycle,
                promptable: false,
                gate: 'missing',
            });
            return;
        }
        recordAgentGate({
            ...(paneKind === undefined ? {} : { kind: paneKind }),
            lifecycle: paneLifecycle,
            promptable: panePromptable,
            gate: panePromptable ? 'ready' : paneLifecycle === 'starting' ? 'starting' : 'not-interactive',
        });
    }, [paneKind, paneLifecycle, paneMissing, panePromptable]);

    // Transient hint so a gesture that found no neighbour doesn't feel dead.
    const [gestureHint, setGestureHint] = React.useState<string | null>(null);
    const hintTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const showGestureHint = React.useCallback((text: string) => {
        setGestureHint(text);
        if (hintTimer.current !== null) clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setGestureHint(null), 1400);
    }, []);
    showGestureHintRef.current = showGestureHint;

    // Returning the computer to this pane rearranges the desktop:
    // occasional, deliberate, and only with control.
    const focusInHerdr = React.useCallback(() => {
        if (focusPending) return;
        setFocusPending(true);
        setFocusFailure(null);
        void sync.request('pane.focus', { sessionId: props.id })
            .then(() => { setActionsOpen(false); showGestureHint('Focused in Herdr'); })
            .catch((error: unknown) => setFocusFailure(humanError(error).message))
            .finally(() => setFocusPending(false));
    }, [focusPending, props.id, showGestureHint]);

    // Product split: the same typed call the overview sheet's New pane uses,
    // with the direction the old control plugin's buttons used to carry.
    const splitPane = React.useCallback((direction: 'right' | 'down') => {
        setActionsOpen(false);
        void sync.request('pane.split', { sessionId: props.id, direction })
            .then((result) => {
                void sync.refreshHerdTree().catch(() => undefined);
                if (result.sessionId !== undefined) navigateToSession(result.sessionId);
            })
            .catch((error: unknown) => {
                Modal.alert('Split failed', humanError(error).message);
                void sync.refreshHerdTree().catch(() => undefined);
            });
    }, [props.id, navigateToSession]);
    React.useEffect(() => { if (!actionsOpen) setFocusFailure(null); }, [actionsOpen]);

    const showRecentLinks = React.useCallback((action: 'open' | 'copy') => {
        const links = recentTerminalLinks(props.id);
        if (links.length === 0) return;
        setActionsOpen(false);
        setMenu({
            title: action === 'open' ? 'Open link' : 'Copy link',
            note: 'From the recent terminal output',
            items: links.map((url) => ({
                label: displayLink(url, 72),
                onPress: action === 'open'
                    ? () => { void openExternalUrl(url); }
                    : () => { void Clipboard.setStringAsync(url).then(() => Modal.alert('Link copied', url)); },
            })),
        });
    }, [props.id]);

    // Coming back to a screen whose socket died while it was backgrounded used
    // to leave a dead terminal until the user navigated away and back. Retry on
    // both edges: screen focus and app foreground. The preview poll rides the
    // same edges, then keeps ticking while the screen is up.
    useFocusEffect(
        React.useCallback(() => {
            channelRef.current?.reconnect();
            void sync.refreshHerdTree().catch(() => undefined);
        }, []),
    );

    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (next) => {
            if (next === 'active') channelRef.current?.reconnect();
        });
        return () => subscription.remove();
    }, []);

    // The action menu is a plain absolute View, not a modal, so Android's
    // hardware back would leave the screen instead of dismissing it.
    React.useEffect(() => {
        if ((menu === null && !actionsOpen) || Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setMenu(null);
            setActionsOpen(false);
            return true;
        });
        return () => subscription.remove();
    }, [actionsOpen, menu]);

    // The agent is a TUI: it can only reach a file by having the path in its
    // prompt. But splicing that path into the draft the moment you attach
    // lands it in the middle of whatever you were typing, so paths ride as
    // chips and are appended once, at send.
    const sendPrompt = React.useCallback(() => {
        // The same immediate guard the quick replies carry: a pane with no
        // agent has nothing to prompt, so Enter never reaches the host to be
        // refused. The draft stays; nothing reaches the shell.
        if (currentPaneRef.current?.agentKind === undefined) {
            showGestureHintRef.current('No agent in this pane');
            return;
        }
        // A booting agent is not a refusal: the host holds the prompt until it
        // can accept it, so let the composer stay live and let the host answer.
        if (attaching || selectedImages.length > 0 || dictationActive) return;
        const text = [draftRef.current.trim(), ...attachedPaths].filter((part) => part !== '').join(' ');
        if (text === '') return;
        const disposition = terminalInputDisposition(currentPaneRef.current, sessionRef.current ?? undefined, text);
        if (disposition.kind === 'blocked') {
            showDialogGuard();
            return;
        }
        const previousDraft = draftRef.current;
        const previousImages = attachedImages;
        draftRef.current = '';
        setDraft('');
        clearDraft();
        setAttachedImages([]);
        const request = disposition.kind === 'answer'
            ? sync.request('session.answer', { sessionId: props.id, answer: disposition.answer })
            : sync.sendMessage(props.id, text);
        void request.catch((error: unknown) => {
            const restoredDraft = [previousDraft, draftRef.current].filter(Boolean).join('\n');
            draftRef.current = restoredDraft;
            setDraft(restoredDraft);
            setAttachedImages((current) => [...previousImages, ...current]);
            Modal.alert('Send failed', error instanceof Error ? error.message : String(error));
        });
    }, [attachedImages, attachedPaths, attaching, clearDraft, dictationActive, selectedImages.length, props.id, showDialogGuard]);

    const handleDraftChange = React.useCallback((text: string) => setDraft(text), []);

    // Files land on the host; their paths are appended only when sending.
    const attachPhotos = React.useCallback(async () => {
        await pickImages();
    }, [pickImages]);

    React.useEffect(() => {
        if (selectedImages.length === 0 || attaching) return;
        setAttaching(true);
        void (async () => {
            try {
                const attachments = [];
                for (const image of selectedImages) {
                    attachments.push({
                        name: image.name,
                        mimeType: image.mimeType,
                        data: encodeBase64(await readFileBytes(image.uri)),
                    });
                }
                const result = await sync.request('session.saveAttachments', {
                    sessionId: props.id,
                    attachments,
                });
                if (result.savedPaths.length !== selectedImages.length) throw new Error('The host did not confirm every image. Please attach them again.');
                if (result.savedPaths.length > 0) {
                    setAttachedImages((previous) => [...previous, ...result.savedPaths.map((path, index) => ({
                        id: selectedImages[index]!.id,
                        uri: selectedImages[index]!.uri,
                        name: selectedImages[index]!.name,
                        path,
                    }))]);
                }
            } catch (error) {
                Modal.alert('Attachment failed', error instanceof Error ? error.message : 'Could not send the file to the host.');
            } finally {
                // In finally, not after the request: a failed upload with the
                // images still queued would re-fire this effect forever.
                clearImages();
                setAttaching(false);
            }
        })();
    }, [selectedImages, attaching, clearImages, props.id]);

    const labels = agentLabels(currentPane);
    const shell = isShellLabels(labels);
    const stopSession = React.useCallback(() => {
        const failureTitle = shell ? 'Could not close pane' : 'Could not stop agent';
        setStopping(true);
        void sessionStop(props.id, {
            confirmClose: (prompt) => Modal.confirm(`${prompt.confirmText}?`, prompt.message, {
                cancelText: 'Cancel',
                confirmText: prompt.confirmText,
                destructive: true,
            }),
            confirmRetry: (message) => Modal.confirm(failureTitle, message, {
                cancelText: 'Cancel',
                confirmText: 'Retry',
            }),
        })
            .then((result) => {
                if (result.status !== 'closed') {
                    setStopping(false);
                    return;
                }
                const index = siblings.indexOf(props.id);
                const remaining = siblings.filter((id) => id !== props.id);
                const next = remaining[index] ?? remaining[remaining.length - 1];
                if (next === undefined) router.back();
                else router.replace(`/session/${encodeURIComponent(next)}`);
            })
            .catch((error: unknown) => {
                setStopping(false);
                Modal.alert(failureTitle, error instanceof Error ? error.message : String(error), [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Retry', onPress: () => stopSession() },
                ]);
            });
    }, [props.id, siblings, shell]);

    const canSend = !dictationActive && !attaching && selectedImages.length === 0 && terminalPaneCanSend(currentPane, draft.trim() !== '' || attachedPaths.length > 0);
    // The ring needs at least one slot to be worth its control; view-only
    // keeps what it can still run, so nothing that was reachable is lost.
    const hasTools = viewControls.commands.length > 0 || canControl;
    // The ring's slots in arc order = list order, running from the anchor's
    // own edge inward. Every slot keeps its permanent route (the status row,
    // the ⋯ menu, the composer); the ring is a shortcut layer.
    const terminalKeyboardCommand = viewControls.commands.find((command) => command.icon === 'keyboard');
    const ringSlots = React.useMemo<RingSlot[]>(() => {
        const slots: RingSlot[] = [];
        if (canControl) slots.push({
            id: 'continue',
            label: 'Continue',
            icon: 'arrow-forward-circle-outline',
            run: () => {
                showGestureHintRef.current(t('commandPalette.sent', { command: 'Continue' }));
                sendCommand('Continue with the current task.');
            },
        });
        slots.push({
            id: 'changes',
            label: 'Review changes',
            icon: 'git-compare-outline',
            ...(changesCount === null ? {} : { badge: changesCount }),
            run: () => router.push(`/session/${encodeURIComponent(props.id)}/changes`),
        });
        if (canControl && Platform.OS !== 'web') slots.push({
            id: 'keyboard',
            label: keyboardVisible ? 'Hide keyboard' : 'Keyboard',
            icon: keyboardVisible ? 'chevron-down-outline' : 'keypad-outline',
            run: () => {
                if (!keyboardVisible) { terminalKeyboardCommand?.run(); return; }
                viewControls.dismissKeyboard();
                Keyboard.dismiss();
            },
        });
        if (canControl) slots.push({
            id: 'commands',
            label: 'Commands',
            icon: 'terminal-outline',
            run: () => openAgentCommands(),
        });
        if (canControl) slots.push({
            id: 'paste',
            label: 'Paste',
            icon: 'clipboard-outline',
            run: () => void pasteToDraft(),
        });
        slots.push({
            id: 'browser',
            label: 'Browser',
            icon: 'globe-outline',
            run: () => router.push(`/session/${encodeURIComponent(props.id)}/takeover`),
        });
        return slots;
    }, [canControl, changesCount, keyboardVisible, openAgentCommands, pasteToDraft, props.id, sendCommand, terminalKeyboardCommand, viewControls]);

    // Where this session sits and how it is allowed to act, in one quiet row.
    // Connection stays out of it: subtitle/send color and the reconnect pill
    // already say it, and saying it twice makes neither read.
    const branch = resolveStatusBarGitBranch(gitStatus?.branch, session?.metadata?.worktree?.branch, session?.metadata?.path);
    const permission = permissionModeChip(session === null || session === undefined ? null : resolveMessageModeMeta(session).permissionMode);
    const linesAdded = gitStatus !== null && gitStatus.linesAdded > 0 ? `+${gitStatus.linesAdded}` : null;
    const linesRemoved = gitStatus !== null && gitStatus.linesRemoved > 0 ? `−${gitStatus.linesRemoved}` : null;
    const hasStatusRow = branch !== null || linesAdded !== null || linesRemoved !== null || permission !== null;
    const contextTitle = labels.taskTitle;
    const headerLifecycle = terminalPaneStatus(currentPane);
    const headerLifecycleLabel = headerLifecycle === 'unknown' || headerLifecycle === 'idle' ? undefined : HERD_STATUS_LABELS[headerLifecycle];
    return (
        <ScopedTheme name="dark"><DarkSurface>{(theme) => {
            const headerStatus = agentStatusColor(headerLifecycle, theme);
            const tabPanes = currentTab?.panes ?? [];
            const paneIndex = tabPanes.findIndex((pane) => pane.sessionId === props.id);
            const paneTotal = tabPanes.length;
            const showConnectingStatus = shownStatus !== 'live' && gestureHint === null && shownStatus === 'connecting';
            const showRetryStatus = shownStatus !== 'live' && gestureHint === null && shownStatus !== 'connecting' && shownStatus !== 'unconfirmed';
            const showUnconfirmedStatus = shownStatus === 'unconfirmed' && gestureHint === null;
            // 31669's leading control: its own circle, outside the field, so the
            // field is the only container on the rail.
            const attachmentAction = <Pressable onPress={attachPhotos} disabled={attaching} accessibilityRole="button" accessibilityLabel="Add attachment" accessibilityState={{ disabled: attaching }}
                style={({ pressed }) => ({ width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 19, backgroundColor: withAlpha(theme.colors.text, 0.06), opacity: attaching ? 0.4 : pressed ? 0.6 : 1 })}>
                <Ionicons name={attaching ? 'hourglass-outline' : 'add'} size={20} color={theme.colors.textSecondary} />
            </Pressable>;
            // One pill that is the composer: idle input, multiline compose,
            // Dictating…, Transcribing… — same geometry, same material, only
            // the contents swap, exactly like the supplied frames.
            const dictating = dictation.recording;
            const transcribing = dictation.transcribing;
            const composerInput = <TextInput
                ref={composerRef}
                value={draft}
                onChangeText={handleDraftChange}
                onSubmitEditing={sendPrompt}
                returnKeyType="send"
                blurOnSubmit
                submitBehavior="blurAndSubmit"
                multiline
                // Web renders multiline as a textarea and defaults it to two
                // rows: the rail stood 12dp taller than its own minimum and the
                // placeholder sat a line above the controls beside it. Native
                // sizes to content already, and there `numberOfLines` would cap
                // the growth instead of seeding it.
                {...(Platform.OS === 'web' ? { rows: 1 } as object : {})}
                placeholder={windowWidth < 340 ? 'Prompt…' : 'Type a prompt…'}
                placeholderTextColor={theme.colors.textSecondary}
                accessibilityLabel="Prompt"
                // Web: remove the focus ring; the rail is not a browser widget.
                style={{ flex: 1, minWidth: 0, color: theme.colors.text, paddingLeft: 12, paddingRight: 2, paddingVertical: 8, fontSize: 15, maxHeight: 120,
                    ...(Platform.OS === 'web' ? { outlineStyle: 'none', outlineWidth: 0 } as any : {}) }}
            />;
            const clearAction = draft === '' ? null : <Pressable onPress={() => setDraft('')} accessibilityRole="button" accessibilityLabel="Clear prompt" hitSlop={8}
                style={({ pressed }) => ({ width: 26, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 13, opacity: pressed ? 0.6 : 1 })}>
                <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
            </Pressable>;
            const dictateAction = <Pressable onPress={dictation.toggle} disabled={transcribing} accessibilityRole="button"
                accessibilityLabel={dictating ? 'Stop dictation' : 'Dictate'}
                accessibilityHint={dictating ? 'Stops listening and transcribes' : undefined}
                accessibilityState={{ busy: transcribing, selected: dictating, disabled: transcribing }}
                style={({ pressed }) => ({ width: 32, height: 38, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                <Ionicons name="mic-outline" size={19} color={theme.colors.textSecondary} />
            </Pressable>;
            // The filled disc and its plane only appear once there is something to
            // send; unarmed it is a quiet outline, never a second bright control
            // competing with the send it is not yet.
            const sendAction = <Pressable onPress={sendPrompt} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }}
                style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? theme.colors.terminal.prompt : withAlpha(theme.colors.text, 0.06), opacity: pressed ? 0.8 : canSend ? 1 : 0.55, transform: [{ scale: pressed && canSend ? 0.94 : 1 }] })}>
                <Ionicons name="send" size={17} color={canSend ? '#101010' : theme.colors.textSecondary} style={{ marginLeft: 1 }} />
            </Pressable>;
            // 31669's trailing control: one circle at the rail's end. With an
            // empty field it is the realtime agent, beside the microphone the
            // way every other app puts it; the moment there is something to
            // send it gives way to send. The plugin owns its own glyph and its
            // own availability — only the circle around it is ours.
            const showRealtimeTrailing = draft === '' && attachedPaths.length === 0 && composerContributions.length > 0 && canControl;
            const trailingAction = showRealtimeTrailing
                ? <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: withAlpha(theme.colors.accent, 0.16), borderWidth: StyleSheet.hairlineWidth, borderColor: withAlpha(theme.colors.accent, 0.35) }}>
                    <PluginSlot slot="session.composer.trailing" context={{ sessionId: props.id, getText: () => draftRef.current, setText: setDraft }} />
                </View>
                : sendAction;
            // Only what the channel can vouch for: 'live' means frames flow with
            // nothing known wrong, so it reads as connected, never as health; a known
            // timeout or lost route reads unconfirmed until the host answers again.
            const statusText = shownStatus === 'live' ? 'connected'
                : shownStatus === 'unconfirmed' ? 'Connection unconfirmed'
                    : shownStatus;

            // Same shape as KeyboardAvoidingView, minus the animation: that padding
            // moves frame by frame and Ghostty reflows its whole grid on every size
            // change, which is the flicker. One step change, one reflow.
            //
            // The bar has to stay in flow below the terminal: Ghostty pads itself to sit
            // above the IME, and it measures the gap below itself to do it, so a bar
            // that floats over it gets counted as empty space and lands on the output.
                return (
                <View ref={screenRef} collapsable={false} style={{ flex: 1, backgroundColor: CANVAS_BLACK, paddingTop: insets.top, paddingBottom: keyboardVisible ? keyboardHeight : 0 }}>
                    {watchingWorkingAgent && <ActiveAgentWakeLock />}

                    {/* One quiet line inside the terminal plane: a back circle,
                        the session identity, the pane pager, and an overflow
                        circle. No band, no border, no shadow — the reference's
                        header is invisible until you look for it. */}
                    <View
                        onLayout={(event) => { if (!hasStatusRow) setHeaderBottom(event.nativeEvent.layout.y + event.nativeEvent.layout.height); }}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 2,
                            paddingHorizontal: 6,
                            paddingTop: 0,
                            backgroundColor: 'transparent',
                        }}
                    >
                        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}
                            style={({ pressed }) => ({ minWidth: 30, minHeight: 28, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                            <Ionicons name="arrow-back" size={18} color={theme.colors.text} />
                        </Pressable>
                        <Pressable onPress={() => setTreeOpen(true)} accessibilityRole="button" accessibilityLabel={`${contextTitle}. ${agentNameLine(labels)}${headerLifecycleLabel === undefined ? '' : `. ${headerLifecycleLabel}`}. ${overlayLabel}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, minHeight: 30, paddingHorizontal: 3 }}>
                            <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={14} />
                            <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, fontWeight: '500', opacity: 0.88 }}>{contextTitle}</Text>
                            {/* Status sentence, not a bare subtitle: the lifecycle verb
                                reads differently whether the agent works, needs you, or
                                is gone; the dot carries the same colour (scout §4.1).
                                Shell panes and unknown lifecycles stay quiet — a live
                                shell is not "Offline". */}
                            {headerLifecycleLabel !== undefined && <View accessible={false} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                                <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: headerStatus.color }} />
                                <Text numberOfLines={1} style={{ color: headerStatus.color, fontSize: 11, fontWeight: '500' }}>{headerLifecycleLabel}</Text>
                            </View>}
                        </Pressable>
                        {/* Position in the tab and the way into the pane overview:
                            borderless and tiny; loading shows as such, never as 0/0. */}
                        <Pressable
                            onPress={() => { setActionsOpen(false); setOverviewOpen(true); }}
                            disabled={!treeLoaded || located === undefined}
                            accessibilityRole="button"
                            accessibilityLabel={treeLoaded && located !== undefined ? `Pane ${Math.max(paneIndex, 0) + 1} of ${Math.max(paneTotal, 1)}. Open panes.` : 'Panes loading'}
                            accessibilityState={{ expanded: overviewOpen, disabled: !treeLoaded || located === undefined }}
                            style={({ pressed }) => ({ minWidth: 32, minHeight: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 1, paddingHorizontal: 4, borderRadius: 10, opacity: pressed ? 0.6 : 1 })}
                        >
                            {/* The count is the affordance; a chevron beside it
                                only made the header look like it carried a menu. */}
                            {treeLoaded && located !== undefined
                                ? <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '500', fontVariant: ['tabular-nums'] }}>{Math.max(paneIndex, 0) + 1}/{Math.max(paneTotal, 1)}</Text>
                                : <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                        </Pressable>
                        {!authorityLoading && <Pressable onPress={() => setActionsOpen((open) => !open)} accessibilityRole="button" accessibilityLabel={`Pane actions${artifactsCount !== null && artifactsCount > 0 ? `, ${t('sessionArtifacts.title', { count: artifactsCount })}` : ''}`}
                            accessibilityState={{ expanded: actionsOpen }} hitSlop={12} style={({ pressed }) => ({ minWidth: 30, minHeight: 28, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                            <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.text} />
                            {artifactsCount !== null && artifactsCount > 0 && <View style={{ position: 'absolute', top: 1, right: 0, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accent }}>
                                <Text style={{ color: theme.colors.surface, fontSize: 9, fontWeight: '700' }}>{artifactsCount > 99 ? '99+' : artifactsCount}</Text>
                            </View>}
                        </Pressable>}
                    </View>

                    {hasStatusRow && (
                        <Pressable
                            onLayout={(event) => setHeaderBottom(event.nativeEvent.layout.y + event.nativeEvent.layout.height)}
                            accessibilityRole="button"
                            accessibilityLabel="Review changes"
                            disabled={branch === null}
                            onPress={() => { if (branch !== null) router.push(`/session/${encodeURIComponent(props.id)}/changes`); }}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 4, backgroundColor: 'transparent' }}>
                            {branch !== null && <Ionicons name="git-branch-outline" size={12} color={theme.colors.textSecondary} />}
                            <SessionMetaLine
                                style={{ flex: 1 }}
                                segments={[
                                    { text: branch },
                                    { text: linesAdded, color: theme.colors.gitAddedText },
                                    { text: linesRemoved, color: theme.colors.gitRemovedText, attached: linesAdded !== null },
                                    { text: permission?.label, ...(permission?.danger === true ? { color: theme.colors.permission.yolo } : {}) },
                                ]}
                            />
                        </Pressable>
                    )}

                    {Platform.OS === 'web' && !canControl && (
                        <View style={{ paddingHorizontal: 12, paddingVertical: 7, backgroundColor: theme.colors.surfaceHigh, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, textAlign: 'center' }}>
                                View-only browser · terminal input and agent controls are disabled · access expires eight hours after pairing
                            </Text>
                        </View>
                    )}

                    <View
                        ref={paneGestures.ref}
                        onLayout={({ nativeEvent }) => setTerminalBox({ top: nativeEvent.layout.y, width: nativeEvent.layout.width, height: nativeEvent.layout.height })}
                        onTouchStart={paneGestures.onTouchStart}
                        onTouchMove={paneGestures.onTouchMove}
                        onTouchEnd={paneGestures.onTouchEnd}
                        style={{ flex: 1 }}
                    >
                        <TerminalView key={attempt} sessionId={props.id} onStatus={onStatus} onChannel={onChannel} onViewControls={setViewControls} />
                        {gestureHint !== null && (
                            <View
                                pointerEvents="none"
                                style={{
                                    position: 'absolute',
                                    top: 12,
                                    alignSelf: 'center',
                                    paddingHorizontal: 12,
                                    paddingVertical: 6,
                                    borderRadius: 999,
                                    backgroundColor: theme.colors.surfaceHigh,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                }}
                            >
                                <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{gestureHint}</Text>
                            </View>
                        )}
                        {showConnectingStatus && (
                                <View
                                    pointerEvents="none"
                                    style={{
                                        position: 'absolute',
                                        top: 12,
                                        alignSelf: 'center',
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        borderRadius: 999,
                                        backgroundColor: theme.colors.surfaceHigh,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                    }}
                                >
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{shownStatus}</Text>
                                </View>
                        )}
                        {showUnconfirmedStatus && (
                                <View
                                    pointerEvents="none"
                                    accessibilityLabel={statusText}
                                    style={{
                                        position: 'absolute',
                                        top: 12,
                                        alignSelf: 'center',
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        borderRadius: 999,
                                        backgroundColor: theme.colors.surfaceHigh,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                    }}
                                >
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{statusText}</Text>
                                </View>
                        )}
                        {showRetryStatus && (
                                <Pressable
                                    onPress={retryTerminal}
                                    hitSlop={8}
                                    accessibilityRole="button"
                                    accessibilityLabel={shownStatus.includes('another device') ? 'Use this terminal here' : `Reconnect terminal. ${statusText}`}
                                    style={({ pressed }) => ({
                                        position: 'absolute',
                                        top: 12,
                                        alignSelf: 'center',
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        borderRadius: 999,
                                        backgroundColor: theme.colors.surfaceHigh,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{statusText}</Text>
                                    <Ionicons name="refresh-outline" size={12} color={theme.colors.textSecondary} />
                                </Pressable>
                        )}
                        {/* Centred, because it is the way back to the live edge
                            and not an accessory of the right-hand chrome, and
                            because the reach that matters on a phone is the
                            middle of the bottom. It fades in only once this
                            pane is known to be off its live edge, so a pane at
                            the bottom shows nothing at all. */}
                        {showJump && (
                            <Animated.View
                                entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)}
                                exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
                                style={{ position: 'absolute', left: 0, right: 0, bottom: 14, alignItems: 'center' }}
                            >
                                <Pressable
                                    onPress={jumpToBottom}
                                    hitSlop={10}
                                    accessibilityRole="button"
                                    accessibilityLabel="Jump to latest output"
                                    style={({ pressed }) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                        minHeight: 36,
                                        paddingLeft: 12,
                                        paddingRight: 14,
                                        borderRadius: 999,
                                        backgroundColor: theme.colors.surfaceHigh,
                                        borderWidth: StyleSheet.hairlineWidth,
                                        borderColor: theme.colors.divider,
                                        elevation: 6,
                                        opacity: pressed ? 0.78 : 1,
                                        transform: [{ scale: pressed ? 0.97 : 1 }],
                                    })}
                                >
                                    <Ionicons name="arrow-down" size={15} color={theme.colors.text} />
                                    <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '600' }}>Latest</Text>
                                </Pressable>
                            </Animated.View>
                        )}
                    </View>

                    {/* Session/pane chip rail, inside the terminal plane: one
                        scrollable row of identity chips for the open panes
                        (or, across tabs, the other tabs); the active chip
                        carries close, a trailing + adds a pane. No band, no
                        underline. */}
                    {(tabPanes.length > 1 || workspaceTabs.length > 1) && !(dictationActive && keyboardVisible) && (
                        <ScrollView
                            ref={tabStripRef}
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            keyboardShouldPersistTaps="always"
                            style={{ maxHeight: 30, backgroundColor: 'transparent', opacity: toolsOpen ? 0.25 : 1 }}
                            contentContainerStyle={{ alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 0 }}
                        >
                            {tabPanes.length > 1 ? tabPanes.map((pane) => {
                                const active = pane.sessionId === props.id;
                                const pl = agentLabels(pane);
                                const tone = agentStatusColor(pane.agentStatus, theme);
                                return (
                                    <View
                                        key={pane.sessionId}
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            maxHeight: 26,
                                            borderRadius: 8,
                                            overflow: 'hidden',
                                            // Names on the plane, not tabs in a strip: the
                                            // current pane is the brighter one, and nothing
                                            // here draws a box around itself.
                                            backgroundColor: active ? withAlpha(theme.colors.text, 0.07) : 'transparent',
                                            borderWidth: 0,
                                            borderColor: 'transparent',
                                        }}
                                    >
                                        <Pressable
                                            onPress={active || pane.sessionId === undefined ? undefined : () => { if (pane.sessionId !== undefined) navigateToSession(pane.sessionId); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${active ? 'Current pane' : 'Open pane'} ${pl.taskTitle}`}
                                            accessibilityState={{ selected: active }}
                                            style={({ pressed }) => ({
                                                minHeight: 24,
                                                maxWidth: 150,
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                gap: 4,
                                                paddingLeft: 7,
                                                paddingRight: active && canControl ? 1 : 7,
                                                opacity: pressed ? 0.65 : 1,
                                            })}
                                        >
                                            <AgentGlyph name={isShellLabels(pl) ? 'shell' : pl.agentKind ?? pl.agentName} size={13} />
                                            <Text numberOfLines={1} style={{ flexShrink: 1, color: active ? theme.colors.text : tone.color, fontSize: 11, fontWeight: active ? '600' : '400' }}>
                                                {pl.taskTitle}
                                            </Text>
                                        </Pressable>
                                        {/* Close lives on the active chip, the same
                                            close the overflow menu carries. */}
                                        {active && canControl && !stopping && <Pressable
                                            onPress={stopSession}
                                            accessibilityRole="button"
                                            accessibilityLabel={shell ? 'Close pane' : 'Stop agent'}
                                            hitSlop={6}
                                            style={({ pressed }) => ({ width: 20, height: 20, alignItems: 'center', justifyContent: 'center', marginRight: 2, borderRadius: 10, opacity: pressed ? 0.6 : 1 })}>
                                            <Ionicons name="close" size={12} color={theme.colors.textSecondary} />
                                        </Pressable>}
                                    </View>
                                );
                            }) : workspaceTabs.map((tab, index) => {
                                const active = tab.tabId === currentTab?.tabId;
                                const single = tab.panes.length === 1 ? tab.panes[0] : undefined;
                                const singleLabels = single === undefined ? undefined : agentLabels(single);
                                const tone = agentStatusColor(tab.agentStatus, theme);
                                const label = tabLabel(tab, index);
                                return (
                                    <View
                                        key={tab.tabId}
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            maxHeight: 26,
                                            borderRadius: 8,
                                            overflow: 'hidden',
                                            // Names on the plane, not tabs in a strip: the
                                            // current pane is the brighter one, and nothing
                                            // here draws a box around itself.
                                            backgroundColor: active ? withAlpha(theme.colors.text, 0.07) : 'transparent',
                                            borderWidth: 0,
                                            borderColor: 'transparent',
                                        }}
                                    >
                                        <Pressable
                                            onLayout={active ? ({ nativeEvent }) => { activeChipX.current = nativeEvent.layout.x; } : undefined}
                                            onPress={active ? undefined : () => openTab(tab)}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${active ? 'Current tab' : 'Open tab'} ${label}, ${tab.panes.length === 1 ? '1 pane' : `${tab.panes.length} panes`}`}
                                            accessibilityState={{ selected: active }}
                                            style={({ pressed }) => ({
                                                minHeight: 24,
                                                maxWidth: 150,
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                gap: 4,
                                                paddingLeft: 7,
                                                paddingRight: 7,
                                                opacity: pressed ? 0.65 : 1,
                                            })}
                                        >
                                            {singleLabels !== undefined
                                                ? <AgentGlyph name={isShellLabels(singleLabels) ? 'shell' : singleLabels.agentKind ?? singleLabels.agentName} size={13} />
                                                : <Ionicons name="grid-outline" size={12} color={theme.colors.textSecondary} />}
                                            <Text numberOfLines={1} style={{ flexShrink: 1, color: active ? theme.colors.text : tone.color, fontSize: 11, fontWeight: active ? '600' : '400' }}>
                                                {label}
                                            </Text>
                                        </Pressable>
                                    </View>
                                );
                            })}
                            {canControl && <Pressable
                                onPress={() => splitPane('right')}
                                accessibilityRole="button"
                                accessibilityLabel="Add pane"
                                hitSlop={6}
                                style={({ pressed }) => ({ width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                                <Ionicons name="add" size={15} color={theme.colors.textSecondary} />
                            </Pressable>}
                        </ScrollView>
                    )}

                    {canControl && <View style={{ backgroundColor: CANVAS_BLACK, opacity: toolsOpen ? 0.25 : 1 }}>
                        {/* The key strip stands down while dictation owns the footer
                            with the keyboard up; the composer capsule stays. */}
                        {!(dictationActive && keyboardVisible) && <TerminalKeyRow channel={channel} onEdit={editKeys} onAction={onKeyAction}>
                            <DeclarativeTerminalKeySlot channel={channel} />
                        </TerminalKeyRow>}

                    <ComposerAttachments
                        images={[...attachedImages, ...selectedImages.filter((image) => !attachedImages.some((attached) => attached.id === image.id))]}
                        onRemove={(id) => setAttachedImages((previous) => previous.filter((image) => image.id !== id))}
                    />

                    {/* The one composer pill. Idle it is `+` · ring · prompt · mic ·
                        send; while the microphone is live the same pill reads
                        Dictating…, then Transcribing…, and commits into the draft.
                        One geometry, one material, every state. */}
                    {/* The rail is three things with air between them, not one
                        slab carrying five: a leading circle, the field — the
                        only container here — and one trailing circle that is
                        the realtime agent while the field is empty and becomes
                        send the moment there is something to send. */}
                    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingHorizontal: 10, paddingTop: 4, paddingBottom: (keyboardVisible ? 8 : insets.bottom + 8) }}>
                        {!dictationActive && attachmentAction}
                        <View style={{
                            flex: 1,
                            minHeight: keyboardVisible ? 44 : 48,
                            borderRadius: keyboardVisible ? 22 : 24,
                            backgroundColor: withAlpha(theme.colors.text, 0.05),
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingLeft: 0,
                            paddingRight: 4,
                            paddingVertical: keyboardVisible ? 3 : 5,
                        }}>
                            {/* Listening is a state, not an alarm: the level and
                                the stop carry the one red between them, and the
                                stop is a tinted target rather than a solid disc
                                the size of the send. */}
                            {dictating ? <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                                <DictationBars level={dictation.level} color={theme.colors.status.error} />
                                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 15, marginLeft: 10 }}>Dictating…</Text>
                                <Pressable onPress={dictation.toggle} accessibilityRole="button" accessibilityLabel="Stop dictation"
                                    accessibilityHint="Stops listening and transcribes"
                                    style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(theme.colors.status.error, pressed ? 0.28 : 0.18), transform: [{ scale: pressed ? 0.94 : 1 }] })}>
                                    <Ionicons name="stop" size={13} color={theme.colors.status.error} />
                                </Pressable>
                            </Animated.View> : transcribing ? <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                                <TranscribingDots color={theme.colors.textSecondary} />
                                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 15, marginLeft: 10 }}>Transcribing…</Text>
                                <Pressable onPress={dictation.cancel} accessibilityRole="button" accessibilityLabel="Cancel dictation"
                                    style={({ pressed }) => ({ width: 34, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 17, opacity: pressed ? 0.6 : 1 })}>
                                    <Ionicons name="close" size={19} color={theme.colors.textSecondary} />
                                </Pressable>
                            </Animated.View> : <>
                                {composerInput}
                                {clearAction}
                                {/* The trigger the arc opens around lives in the
                                    field beside the microphone, so the ring blooms
                                    from something that belongs to the composer
                                    rather than from a puck parked on the terminal. */}
                                {railShowsRing && <>
                                    <View ref={ringSlotRef} onLayout={measureRingAnchor} collapsable={false} pointerEvents="none" style={{ width: RING_CENTER_SIZE, height: 38 }} />
                                    {dictateAction}
                                </>}
                            </>}
                        </View>
                        {!dictationActive && trailingAction}
                    </View>
                    </View>}

                    {/* The one way into the terminal's quick actions: the ring
                        docked at the composer's thumb control, blooming over the
                        terminal. The region ends at the terminal's bottom edge,
                        so the fan can never reach the composer. View-only keeps
                        a resting anchor in the corner; the ring is transient and
                        never touches the keyboard. */}
                    {/* With control authority the ring belongs to the rail, so it
                        waits for its own measurement rather than flashing once in
                        the terminal's corner on the frame between the two layout
                        commits. View-only has no rail to dock in and keeps the
                        corner anchor. */}
                    {hasTools && terminalBox !== undefined && (!canControl || (railShowsRing && ringCenter !== undefined)) && (() => {
                        const docked = canControl && ringCenter !== undefined;
                        // The overlay reaches down over the rail so the docked
                        // centre control sits exactly on its slot; the fan itself
                        // solves only in the area above it, bounded by `fanHeight`.
                        const regionHeight = docked
                            ? Math.max(terminalBox.height, ringCenter.y + RING_CENTER_SIZE - terminalBox.top)
                            : terminalBox.height;
                        const anchor = docked
                            ? { x: ringCenter.x, y: ringCenter.y - terminalBox.top }
                            : { x: Math.max(44, terminalBox.width - 44), y: Math.max(120, terminalBox.height - 84) };
                        return <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: terminalBox.top, height: regionHeight }}>
                            <FloatingTerminalControls open={toolsOpen} onOpenChange={setToolsOpen}
                                width={terminalBox.width} height={regionHeight} fanHeight={terminalBox.height}
                                slots={ringSlots} anchor={anchor} />
                        </View>;
                    })()}

                    <TerminalControlGrid
                        visible={controlGrid.open}
                        category={controlGrid.category}
                        onCategoryChange={(category) => setControlGrid((current) => ({ ...current, category }))}
                        onClose={() => setControlGrid((current) => ({ ...current, open: false }))}
                        entries={rowEntries}
                        seed={rowSeed}
                        onChange={setRowEntries}
                        replies={personalReplies}
                        onRepliesChange={setPersonalReplies}
                        recentLinks={recentTerminalLinks(props.id)}
                        onRecentLink={(url, action) => {
                            setControlGrid((current) => ({ ...current, open: false }));
                            if (action === 'open') void openExternalUrl(url);
                            else void Clipboard.setStringAsync(url).then(() => showGestureHintRef.current('Link copied'));
                        }}
                        viewCommands={viewControls.commands}
                        keyboardDisabled={terminalKeyboardDisabled === true}
                        onKeyboardDisabledChange={setTerminalKeyboardDisabled}
                    />
                    <PaneOverviewSheet visible={overviewOpen} sessionId={props.id} onClose={() => setOverviewOpen(false)} />
                    <WorkspaceTreeSheet visible={treeOpen} sessionId={props.id} onClose={() => setTreeOpen(false)} />
                    <PluginSlot
                        slot="session.overlay"
                        context={{ sessionId: props.id, visible: treeOpen, onClose: () => setTreeOpen(false), openMenu: setMenu, showHint: showGestureHint }}
                    />

                    {/* Secondary actions belong to the header; view controls stay with the terminal. */}
                    {actionsOpen && (
                        <Animated.View
                            exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)}
                            accessibilityViewIsModal
                            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20, alignItems: 'flex-end', justifyContent: 'flex-start' }}
                        >
                            <Animated.View pointerEvents="none" entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.18)' }} />
                            <Pressable onPress={() => setActionsOpen(false)} accessibilityLabel="Close pane actions" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
                            <AnimatedPopup style={{
                                flexShrink: 1,
                                minWidth: 236,
                                maxWidth: 320,
                                marginRight: 8,
                                marginLeft: 16,
                                marginTop: headerBottom + 8,
                                marginBottom: (keyboardVisible ? keyboardHeight : insets.bottom) + 8,
                                borderRadius: 14,
                                overflow: 'hidden',
                                // Rows carry the lighter fill; the surface behind them is
                                // only ever seen through the gap above the stop control.
                                backgroundColor: theme.colors.surface,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: theme.colors.divider,
                                transformOrigin: 'top right',
                                elevation: 12,
                            }}>
                                <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} keyboardShouldPersistTaps="always">
                                    <Text style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>Inspect</Text>
                                    <Pressable onPress={() => { setActionsOpen(false); setFindOpen(true); }} accessibilityRole="button" accessibilityLabel="Find in output"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Find in output</Text>
                                    </Pressable>
                                    {/* The ring carries this too, but the ring leaves the
                                        rail while a prompt is being typed — which is
                                        exactly when a command is most likely wanted. The
                                        menu is its permanent route. */}
                                    {canControl && <Pressable onPress={() => { setActionsOpen(false); openAgentCommands(); }} accessibilityRole="button" accessibilityLabel="Agent commands"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Agent commands</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>}
                                    {/* The rail's microphone yields to a typed draft, and
                                        dictation appends rather than replaces, so the one
                                        flow that would otherwise be out of reach — speak
                                        the rest of a prompt you started typing — lives
                                        here. */}
                                    {canControl && <Pressable onPress={() => { setActionsOpen(false); dictation.toggle(); }} disabled={dictationActive} accessibilityRole="button" accessibilityLabel="Dictate into the prompt"
                                        accessibilityHint="Adds what you say to the prompt. It never sends by itself."
                                        accessibilityState={{ disabled: dictationActive }}
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh, opacity: dictationActive ? 0.4 : 1 })}>
                                        <Ionicons name="mic-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Dictate into the prompt</Text>
                                    </Pressable>}
                                    <Pressable onPress={() => { setActionsOpen(false); router.push(`/session/${encodeURIComponent(props.id)}/takeover`); }} accessibilityRole="button" accessibilityLabel="Browser"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="globe-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Browser</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    <Pressable onPress={() => { setActionsOpen(false); router.push(`/session/${encodeURIComponent(props.id)}/history`); }} accessibilityRole="button" accessibilityLabel="Conversation history"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="document-text-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Conversation history</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    <Pressable onPress={() => { setActionsOpen(false); router.push(`/session/${encodeURIComponent(props.id)}/artifacts`); }} accessibilityRole="button" accessibilityLabel={`Shared Artifacts${artifactsCount === null ? '' : `, ${t('sessionArtifacts.title', { count: artifactsCount })}`}`}
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="albums-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Shared Artifacts</Text>
                                        {artifactsCount !== null && <View style={{ minWidth: 24, height: 22, paddingHorizontal: 7, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceHighest }}>
                                            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' }}>{artifactsCount}</Text>
                                        </View>}
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    <Pressable onPress={() => { setActionsOpen(false); router.push('/usage'); }} accessibilityRole="button" accessibilityLabel={t('usage.title')}
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="speedometer-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{t('usage.title')}</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    {canControl && <DeclarativeSessionActions actions={declaredActions} sessionId={props.id} onNavigate={() => setActionsOpen(false)} />}
                                    {canControl && (
                                        <View>
                                            <Pressable onPress={() => splitPane('right')} accessibilityRole="button" accessibilityLabel="Split right"
                                                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                                <Ionicons name="git-commit-outline" size={18} color={theme.colors.textSecondary} />
                                                <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Split right</Text>
                                            </Pressable>
                                            <Pressable onPress={() => splitPane('down')} accessibilityRole="button" accessibilityLabel="Split down"
                                                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                                <Ionicons name="git-commit-outline" size={18} color={theme.colors.textSecondary} style={{ transform: [{ rotate: '90deg' }] }} />
                                                <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Split down</Text>
                                            </Pressable>
                                        </View>
                                    )}
                                    {canControl && <Pressable onPress={focusInHerdr} disabled={socketStatus.status !== 'connected' || focusPending} accessibilityRole="button"
                                        accessibilityLabel={socketStatus.status === 'connected' ? 'Focus in Herdr' : 'Focus in Herdr, unavailable: not connected'}
                                        accessibilityState={{ disabled: socketStatus.status !== 'connected' || focusPending, busy: focusPending }}
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh, opacity: socketStatus.status === 'connected' ? 1 : 0.5 })}>
                                        <View style={{ flex: 1 }}>
                                            <Text style={{ color: theme.colors.text, fontSize: 15 }}>Focus in Herdr</Text>
                                            {socketStatus.status !== 'connected' && <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>Not connected</Text>}
                                            {focusFailure !== null && <Text style={{ color: theme.colors.status.error, fontSize: 12, marginTop: 2 }}>{`Could not focus: ${focusFailure}. Tap to retry.`}</Text>}
                                        </View>
                                        {focusPending && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                                    </Pressable>}
                                    {recentTerminalLinks(props.id).length > 0 && <>
                                        <Pressable onPress={() => showRecentLinks('open')} accessibilityRole="button" accessibilityLabel="Open recent terminal link"
                                            style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                            <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
                                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Open link</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                        <Pressable onPress={() => showRecentLinks('copy')} accessibilityRole="button" accessibilityLabel="Copy recent terminal link"
                                            style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                            <Ionicons name="copy-outline" size={18} color={theme.colors.textSecondary} />
                                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Copy link</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    </>}
                                    {/* Realtime voice is product code, so its row is always
                                        offered; the slot row below stays for third-party
                                        contributions to the same place. */}
                                    {canControl && <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 8, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }}>
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Talk to this session</Text>
                                        <RealtimeTalkButton sessionId={props.id} accessibilityLabel="Talk to this session" />
                                    </View>}
                                    {canControl && composerContributions.length > 0 && <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 8, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }}>
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{composerSlotLabel ?? 'Session tools'}</Text>
                                        <PluginSlot slot="session.composer.trailing" context={{ sessionId: props.id, getText: () => draftRef.current, setText: setDraft }} />
                                    </View>}
                                    <Text style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>View</Text>
                                    {canControl && <Pressable onPress={editKeys} accessibilityRole="button" accessibilityLabel="Edit terminal keys"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="options-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Edit terminal keys</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>}
                                    {canControl && <Pressable onPress={() => { setActionsOpen(false); setControlGrid({ open: true, category: 'snippets' }); }} accessibilityRole="button" accessibilityLabel="Edit quick replies"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="chatbubbles-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Edit quick replies</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>}
                                    {viewControls.commands.map((command) => (
                                        <Pressable key={command.label} onPress={() => { setActionsOpen(false); command.run(); }} disabled={command.disabled}
                                            accessibilityRole="button" accessibilityLabel={command.label} accessibilityState={{ disabled: !!command.disabled }}
                                            style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh, opacity: command.disabled ? 0.4 : 1 })}>
                                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{command.label}</Text>
                                        </Pressable>
                                    ))}
                                    {canControl && <Pressable onPress={() => setTerminalKeyboardDisabled(!terminalKeyboardDisabled)} accessibilityRole="button"
                                        accessibilityLabel={terminalKeyboardDisabled ? 'Enable keyboard on tap' : 'Disable keyboard on tap'}
                                        accessibilityState={{ selected: terminalKeyboardDisabled }}
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{terminalKeyboardDisabled ? 'Enable keyboard on tap' : 'Disable keyboard on tap'}</Text>
                                    </Pressable>}
                                    {canControl && pluginButtons.length > 0 && <Text style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>Pane controls</Text>}
                                    {canControl && pluginButtons.map((button) => {
                                        const key = `${button.pluginId}:${button.id}`;
                                        return <Pressable key={key} onPress={() => {
                                            if (pluginActionBusy !== undefined) return;
                                            setActionsOpen(false);
                                            setExtensionActionBusy(key);
                                            void sync.request('plugin.invoke', {
                                                pluginId: button.pluginId,
                                                manifestHash: button.manifestHash,
                                                contributionId: button.id,
                                                sessionId: props.id,
                                                idempotencyKey: randomUUID(),
                                            }).catch((error) => Modal.alert(`${button.name} failed`, error instanceof Error ? error.message : String(error)))
                                                .finally(() => setExtensionActionBusy(undefined));
                                        }} disabled={pluginActionBusy !== undefined} accessibilityRole="button" accessibilityLabel={resolvePluginText(button.label)} accessibilityState={{ busy: pluginActionBusy === key, disabled: pluginActionBusy !== undefined }}
                                            style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                            {pluginActionBusy === key ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Ionicons name="extension-puzzle-outline" size={18} color={theme.colors.textSecondary} />}
                                            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{resolvePluginText(button.label)}</Text>
                                        </Pressable>;
                                    })}
                                </ScrollView>
                                {/* Closing the pane is the one row here that destroys
                                    something, so it never scrolls away and never sits in
                                    the run of things you were only going to look at. */}
                                {canControl && !stopping && (
                                    <Pressable onPress={() => { setActionsOpen(false); stopSession(); }} accessibilityRole="button" accessibilityLabel={shell ? 'Close pane' : 'Stop agent'}
                                        style={({ pressed }) => ({ minHeight: 44, marginTop: 5, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="stop-circle-outline" size={18} color={theme.colors.status.error} />
                                        <Text style={{ flex: 1, color: theme.colors.status.error, fontSize: 15 }}>{shell ? 'Close pane' : 'Stop agent'}</Text>
                                    </Pressable>
                                )}
                            </AnimatedPopup>
                        </Animated.View>
                    )}

                    {menu !== null && (
                        <Pressable
                            onPress={() => setMenu(null)}
                            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
                        >
                            <View style={{ backgroundColor: theme.colors.surface, paddingBottom: insets.bottom + 8, borderTopLeftRadius: 14, borderTopRightRadius: 14 }}>
                                <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 }}>
                                    <Text style={{ color: theme.colors.text, fontWeight: '600', fontSize: 16 }}>{menu.title}</Text>
                                    {menu.note !== undefined && (
                                        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>{menu.note}</Text>
                                    )}
                                </View>
                                <ScrollView style={{ maxHeight: 380 }}>
                                    {menu.items.map((item) => (
                                        <Pressable
                                            key={item.label}
                                            onPress={() => {
                                                setMenu(null);
                                                item.onPress();
                                            }}
                                            style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 12, opacity: pressed ? 0.6 : 1 })}
                                        >
                                            <Text style={{ color: item.destructive === true ? theme.colors.status.error : theme.colors.text, fontSize: 15 }}>{item.label}</Text>
                                            {item.hint !== undefined && (
                                                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>{item.hint}</Text>
                                            )}
                                        </Pressable>
                                    ))}
                                </ScrollView>
                                <Pressable onPress={() => setMenu(null)} style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 15 }}>Cancel</Text>
                                </Pressable>
                            </View>
                        </Pressable>
                    )}
                    {findOpen && <FindOutputSheet sessionId={props.id} keyboardOffset={Platform.OS === 'web' || !keyboardVisible ? 0 : keyboardHeight} onClose={() => setFindOpen(false)} />}
                </View>
            );
        }}</DarkSurface></ScopedTheme>
    );
});
