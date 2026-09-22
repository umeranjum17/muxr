/**
 * The session screen: a live terminal, not a transcript.
 *
 * Herdr backs every agent CLI, so there is no per-agent transcript to render --
 * what the agent draws is what you see, and the keys you would press at the desk
 * are the ones the toolbar sends. Approvals happen in the terminal itself.
 */

import { RealtimeTalkButton } from '@/conversation/ui';
import * as React from 'react';
import { ActivityIndicator, AppState, BackHandler, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, type SharedValue } from 'react-native-reanimated';
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
import { FloatingTerminalControls, TerminalMenuQuickActions, floatingControlFits, type ClusterKey, type RingHandle, type RingSlot } from './FloatingTerminalControls';
import { TerminalKeyRow } from './TerminalKeyRow';
import { TerminalControlGrid, type ControlGridCategory } from './TerminalKeyRowEditor';
import { ARROW_CLUSTER, BUILTIN_KEY_CATALOG, DEFAULT_ROW_IDS, type RowEntry, type TerminalKeyAction } from '../domain/keyRow';
import { resolveQuickActions, type QuickAction } from '../domain/quickActions';
import { quickActionCommand } from '../application/quickActionCommands';
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
import { TerminalLinkMenu, terminalLinkCardFits, type LinkAction } from './TerminalLinkMenu';
import { openTerminalLink, safeTerminalLinkUrl } from '../domain/safeTerminalLink';
import { humanError } from '@/utils/errors';
import { CommandPalette } from '@/components/CommandPalette';
import type { Command } from '@/components/CommandPalette/types';
import { CUSTOM_CATEGORY } from '@/components/CommandPalette/types';
import { agentCommands, destructiveCommand, type AgentCommand } from '../domain/agentCommands';
import { agentKindLabel } from '@/herd';
import { t } from '@/text';
import { FindOutputSheet } from './FindOutputSheet';
import { useTerminalQuickReplies } from '@/plugins/ui';

/** What a reply row's primary tap really does, for replies that never send. */
const INSERT_ONLY_LABEL = 'Inserts into the prompt, never sends.';
/** The editor row is the one Custom row that opens a sheet rather than typing. */
const OPENS_EDITOR_LABEL = 'Opens the controls editor.';

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
// The material is decided once, in the theme (`terminalChrome`): the canvas is
// the Ghostty background itself, and every surface that is not the terminal --
// the header line, the pane rail, the key marks, the composer, the floating
// control and its ring -- is the same ink one step up from it. Enough to see
// where the terminal ends; not enough for either surface to announce itself.
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
    //
    // Both read through a selector: without one the hook hands back a fresh
    // state object on every keyboard event, including the `willShow` that only
    // carries an appearance, so a single keyboard opening re-rendered this
    // whole screen three times over. A primitive lets React drop the renders
    // that change nothing, which is most of them.
    const keyboardVisible = useKeyboardState((state) => state.isVisible);
    const keyboardHeight = useKeyboardState((state) => state.height);
    const session = useSession(props.id);
    const sessions = useSessions();
    const { workspaces, loaded: treeLoaded } = useHerdrTree();
    const storedPane = herdrPaneForSession(workspaces, props.id);
    const gitStatus = useSessionGitStatus(props.id);
    const pluginButtons = useSessionPlugins();
    const declaredActions = useDeclarativeSessionActions(session?.metadata?.path);
    const pluginQuickReplies = useTerminalQuickReplies();
    const [changesCount, setChangesCount] = React.useState<number | null>(null);
    const [artifactsCount, setArtifactsCount] = React.useState<number | null>(null);
    useFocusEffect(React.useCallback(() => {
        let cancelled = false;
        changesList(props.id)
            .then((badge) => { if (!cancelled) setChangesCount(badge.count); })
            .catch(() => { if (!cancelled) setChangesCount(null); });
        const unsubscribe = registerArtifactUpdateHandler((sessionId, event) => {
            if (!cancelled && sessionId === props.id) setArtifactsCount(event.total);
        });
        return () => { cancelled = true; unsubscribe(); };
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
    const [storedActions, setStoredActions] = useLocalSettingMutable('terminalQuickActions');
    // The seeds are a starting list, not a fixed row: once anything is stored,
    // including the empty list, the stored one is the whole truth.
    const quickActions = React.useMemo(() => resolveQuickActions(storedActions), [storedActions]);
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
    // The ring is hosted by the screen, never by the terminal renderer. It owns
    // its own open state so that opening it re-renders one small component
    // rather than this whole screen on the frame the bloom starts; the screen
    // only ever closes it, and reads how far it is open from a shared value the
    // rails recede by on the UI thread.
    const ringRef = React.useRef<RingHandle>(null);
    const ringDim = useSharedValue(0);
    const ringRecede = useAnimatedStyle(() => ({ opacity: 1 - ringDim.value * 0.78 }));
    // The ring's overlay is the terminal plus the rails under it: the scrim it
    // draws covers everything it could bloom over, and a terminal too short for
    // the arc can borrow that space instead of losing an action.
    const [ringOverlay, setRingOverlay] = React.useState(0);
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
    // Held in a ref so the link menu, built once, always inserts through the
    // current draft rather than a captured one.
    const insertDraftRef = React.useRef<(value: string) => void>(() => {});
    const insertDraft = React.useCallback((value: string) => {
        const next = appendToDraft(draftRef.current, value);
        draftRef.current = next;
        setDraft(next);
        // The palette animates out; focus once its input has released the IME.
        setTimeout(() => composerRef.current?.focus(), 280);
    }, []);

    insertDraftRef.current = insertDraft;

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
    // The artifact count is a badge; the terminal is why this screen was
    // opened. Asking the host to enumerate a pane's whole history while it is
    // still answering this pane's attach put a directory walk in front of the
    // first frame, so it waits until the pane is actually live.
    const countedSession = React.useRef<string | undefined>(undefined);
    const liveSession = React.useRef(props.id);
    liveSession.current = props.id;
    React.useEffect(() => {
        const sessionId = props.id;
        if (!isFocused || status !== 'live' || countedSession.current === sessionId) return;
        countedSession.current = sessionId;
        sync.artifactList(sessionId)
            .then((result) => { if (liveSession.current === sessionId) setArtifactsCount(result.total); })
            .catch(() => { if (liveSession.current === sessionId) setArtifactsCount(null); });
    }, [isFocused, status, props.id]);
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
        if (actionsOpen || overviewOpen || treeOpen || findOpen || controlGrid.open || menu !== null) ringRef.current?.close();
    }, [actionsOpen, overviewOpen, treeOpen, findOpen, controlGrid.open, menu]);
    const openControls = React.useCallback((category: ControlGridCategory) => { ringRef.current?.close(); setActionsOpen(false); setControlGrid({ open: true, category }); }, []);
    // Held steady so the memoised key row is not rebuilt by a new child element
    // on every keystroke in the composer above it.
    const keySlot = React.useMemo(() => <DeclarativeTerminalKeySlot channel={channel} />, [channel]);
    const editKeys = React.useCallback(() => openControls('keys'), [openControls]);
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
        ringRef.current?.close();
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
        const toEntry = (entry: AgentCommand, category: string): Command => {
            const asksFirst = destructiveCommand(paneKind, entry.command) !== undefined;
            return {
                id: entry.command,
                title: entry.command,
                hint: entry.arguments,
                subtitle: entry.description,
                destructive: asksFirst || undefined,
                category,
                action: asksFirst
                    ? () => sendDangerous(entry)
                    : () => {
                        showGestureHintRef.current(t('commandPalette.sent', { command: entry.command }));
                        sendCommand(entry.command);
                    },
                secondaryAction: () => insertDraft(`${entry.command} `),
            };
        };
        // One policy for both routes: a command asks before sending because of
        // its text, not because of where it was authored. The person's own
        // actions send on tap; only one naming a destructive command asks the
        // same question its catalogue row asks, and the pencil is the way to
        // fill the prompt instead.
        const toQuickAction = (action: QuickAction, category: string): Command =>
            quickActionCommand(action, category, {
                agentKind: paneKind,
                sentHint: (label) => showGestureHintRef.current(t('commandPalette.sent', { command: label })),
                send: sendCommand,
                confirmDangerous: sendDangerous,
                insert: insertDraft,
            });
        const entries: Command[] = [
            // Replies live in the slash catalogue, at the top, so the canned
            // prompts have one home with the commands (report §8).
            ...quickActions.filter((action) => action.kind === 'reply').map((action) => toQuickAction(action, t('commandPalette.commonReplies'))),
            // A host-contributed reply still only lands in the draft, as it
            // always has, so its row must not announce that it sends.
            ...pluginQuickReplies.map((reply, index): Command => ({
                id: `reply:plugin:${index}:${reply.label}`,
                title: reply.label,
                category: t('commandPalette.commonReplies'),
                action: () => insertDraft(reply.text),
                actionLabel: INSERT_ONLY_LABEL,
                secondaryAction: () => insertDraft(reply.text),
            })),
            // The person's own commands sit with the agent's, above them: they
            // are the ones they chose to keep.
            ...quickActions.filter((action) => action.kind === 'command').map((action) => toQuickAction(action, t('commandPalette.yourCommands'))),
            ...known.filter((entry) => entry.common === true && entry.dangerous !== true).map((entry) => toEntry(entry, t('commandPalette.common'))),
            ...known.filter((entry) => entry.common !== true && entry.dangerous !== true).map((entry) => toEntry(entry, t('commandPalette.allCommands', { kind: kindLabel ?? '' }))),
            ...known.filter((entry) => entry.dangerous === true).map((entry) => toEntry(entry, t('commandPalette.destructive'))),
        ];
        entries.push({
            id: 'custom-command', title: t('commandPalette.typeCommand'), subtitle: t('commandPalette.insertSlash'),
            category: CUSTOM_CATEGORY, action: () => insertDraft('/'),
        });
        // The way from using these to editing them, from the surface they are
        // used on: otherwise the only route in is a sheet two taps away.
        entries.push({
            id: 'edit-quick-actions', title: t('commandPalette.editQuickActions'), actionLabel: OPENS_EDITOR_LABEL,
            category: CUSTOM_CATEGORY, action: () => setControlGrid({ open: true, category: 'snippets' }),
        });
        Modal.show({ component: CommandPalette, props: {
            appearance: 'terminal',
            title: known.length > 0 ? t('commandPalette.agentCommands', { agent: kindLabel ?? '' }) : t('commandPalette.commandsTitle'),
            quietLine: known.length > 0 ? undefined : t('commandPalette.noCatalogue', { kind: paneKind ?? t('commandPalette.thisAgent') }),
            commands: entries,
        } } as any);
    }, [canControl, insertDraft, paneKind, pluginQuickReplies, quickActions, sendCommand, showDialogGuard]);
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

    /**
     * What you can do with ONE link the terminal printed. The link is the
     * subject and it names itself in the note, so there is never a doubt which
     * one is about to be opened.
     *
     * Opening stays a deliberate choice on an exact, scheme-checked URL —
     * nothing here auto-opens — and inserting puts the exact URL in the prompt
     * without sending it.
     */
    // Where the last touch landed inside the terminal, so a link menu opens on
    // the link rather than at a screen edge. The native grid reports which link
    // was reached for but not where, and this is already being observed for the
    // pane swipe, so nothing new is watched.
    const terminalTouch = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const [linkMenu, setLinkMenu] = React.useState<{ url: string; at: { x: number; y: number } } | null>(null);
    const showLinkActions = React.useCallback((url: string, at?: { x: number; y: number }) => {
        if (safeTerminalLinkUrl(url) === null && !url.startsWith('http')) return;
        setActionsOpen(false);
        setMenu(null);
        setLinkMenu({ url, at: at ?? terminalTouch.current });
    }, []);
    const linkActions = React.useMemo<LinkAction[]>(() => {
        const url = linkMenu?.url ?? '';
        const safe = safeTerminalLinkUrl(url);
        return [
            ...(safe === null ? [] : [{ id: 'open', label: 'Open', icon: 'open-outline' as const, run: () => { void openExternalUrl(safe); } }]),
            { id: 'copy', label: 'Copy', icon: 'copy-outline' as const, run: () => { void Clipboard.setStringAsync(url).then(() => showGestureHintRef.current('Link copied')); } },
            // Watching a pane has no prompt on screen, so inserting into one
            // would land the link in a draft nobody can see.
            ...(canControl ? [{ id: 'insert', label: 'Insert into the prompt', icon: 'return-down-forward-outline' as const, note: INSERT_ONLY_LABEL, run: () => insertDraftRef.current(url) }] : []),
        ];
    }, [canControl, linkMenu]);
    const compactLinkMenu = linkMenu !== null && !terminalLinkCardFits(terminalBox?.height, linkActions.length);
    const visibleMenu: SessionMenu | null = menu ?? (compactLinkMenu && linkMenu !== null ? {
        title: displayLink(linkMenu.url, 72),
        items: linkActions.map((action) => ({ label: action.label, hint: action.note, onPress: action.run })),
    } : null);

    /** The links this pane printed recently, each offering the same choices. */
    const showRecentLinks = React.useCallback(() => {
        const links = recentTerminalLinks(props.id);
        if (links.length === 0) return;
        setActionsOpen(false);
        setMenu({
            title: 'Recent links',
            note: 'From the recent terminal output',
            items: links.map((url) => ({ label: displayLink(url, 72), onPress: () => showLinkActions(url) })),
        });
    }, [props.id, showLinkActions]);

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
        if ((menu === null && !actionsOpen && !compactLinkMenu) || Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setMenu(null);
            setLinkMenu(null);
            setActionsOpen(false);
            return true;
        });
        return () => subscription.remove();
    }, [actionsOpen, menu, compactLinkMenu]);

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
            short: 'Changes',
            icon: 'git-compare-outline',
            ...(changesCount === null ? {} : { badge: changesCount }),
            run: () => router.push(`/session/${encodeURIComponent(props.id)}/changes`),
        });
        // The arrows, at the size the thumb that reaches for them deserves. The
        // key row keeps them too; this is the one-handed way to hold one down
        // while watching what it moves. The keyboard's own show/hide stays on
        // the key row, in the control grid, and inside the cluster itself.
        if (canControl) slots.push({
            id: 'arrows',
            label: 'Arrow keys',
            short: 'Arrows',
            icon: 'move-outline',
            opens: 'cluster',
            // The cluster declines a terminal too short for a 38dp key; the
            // arrows stay on the key row, and the slot says so.
            run: () => { showGestureHintRef.current('Arrows stay on the key row'); },
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
    }, [canControl, changesCount, openAgentCommands, pasteToDraft, props.id, sendCommand]);

    // The cross the ring's Arrows slot summons: the row's own catalog keys, the
    // row's own bytes, the row's own hold-to-repeat. Centre is Enter, the way
    // the reference arranges it.
    const clusterKeys = React.useMemo<ClusterKey[]>(() => {
        const marks: Record<string, ClusterKey['icon']> = {
            up: 'arrow-up', left: 'arrow-back', enter: 'return-down-back', right: 'arrow-forward', down: 'arrow-down',
        };
        return ARROW_CLUSTER.flatMap((spot) => {
            const entry = BUILTIN_KEY_CATALOG[spot.id];
            const icon = marks[spot.id];
            if (entry === undefined || icon === undefined) return [];
            return [{
                id: spot.id,
                at: spot.at,
                icon,
                label: entry.accessibilityLabel,
                ...(entry.repeat === true ? { repeat: true } : {}),
                run: () => channel?.sendText(entry.send),
            }];
        });
    }, [channel]);

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
            // The rail's one alignment rule. The field is the tallest thing on
            // the row and it carries its own padding, so the band its text
            // actually occupies is `RAIL_BAND`. Every control — the two ends
            // outside the field and the two marks inside it — reserves exactly
            // that band and hangs from the bottom of the row. Collapsed, each
            // control fills the field's text box and so reads centred on the
            // rail; grown, each one stays on the field's last line instead of
            // drifting up the middle of a tall box.
            //
            // One measure, keyboard up or down: the rail used to lose 4dp when
            // the keyboard arrived, so every control on it resized on the same
            // frame the terminal was reflowing. The 4dp bought nothing and the
            // resize was visible.
            const RAIL_MEASURE = 48;
            const FIELD_PAD = 5;
            const RAIL_BAND = RAIL_MEASURE - FIELD_PAD * 2;
            const RAIL_END = RAIL_BAND;
            const railEnd = (child: React.ReactNode) => <View style={{ height: RAIL_BAND, marginBottom: FIELD_PAD, alignItems: 'center', justifyContent: 'center' }}>{child}</View>;
            const endCircle = (pressed: boolean, tint?: string) => ({
                width: RAIL_END, height: RAIL_END, borderRadius: RAIL_END / 2,
                alignItems: 'center' as const, justifyContent: 'center' as const,
                backgroundColor: tint ?? withAlpha(theme.colors.text, 0.14),
                opacity: pressed ? 0.7 : 1,
            });
            // The leading control: its own circle, outside the field, so the
            // field is the only container on the rail.
            const attachmentAction = railEnd(<Pressable onPress={attachPhotos} disabled={attaching} accessibilityRole="button" accessibilityLabel="Add attachment" accessibilityState={{ disabled: attaching }}
                style={({ pressed }) => ({ ...endCircle(pressed), opacity: attaching ? 0.4 : pressed ? 0.7 : 1 })}>
                <Ionicons name={attaching ? 'hourglass-outline' : 'add'} size={20} color={theme.colors.textSecondary} />
            </Pressable>);
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
            // In-field controls are circles on one size, like everything else
            // on this rail: the screen has exactly two shapes, a round control
            // and a soft-cornered card, and nothing in between.
            const IN_FIELD = 30;
            const inField = {
                width: IN_FIELD, height: RAIL_BAND, borderRadius: IN_FIELD / 2,
                alignItems: 'center' as const, justifyContent: 'center' as const,
                alignSelf: 'flex-end' as const,
            };
            const clearAction = draft === '' ? null : <Pressable onPress={() => setDraft('')} accessibilityRole="button" accessibilityLabel="Clear prompt" hitSlop={8}
                style={({ pressed }) => ({ ...inField, opacity: pressed ? 0.6 : 1 })}>
                <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
            </Pressable>;
            // The microphone stays on the rail whatever is in the field: it
            // appends to the draft rather than replacing it, so speaking the
            // rest of a half-typed prompt is the same control, in the same
            // place, as speaking the whole of one.
            const dictateAction = <Pressable onPress={dictation.toggle} disabled={transcribing} accessibilityRole="button"
                accessibilityLabel={dictating ? 'Stop dictation' : 'Dictate'}
                accessibilityHint={dictating ? 'Stops listening and transcribes' : 'Adds what you say to the prompt. It never sends by itself.'}
                accessibilityState={{ busy: transcribing, selected: dictating, disabled: transcribing }}
                style={({ pressed }) => ({ ...inField, opacity: pressed ? 0.6 : 1 })}>
                <Ionicons name="mic-outline" size={19} color={theme.colors.textSecondary} />
            </Pressable>;
            // Send is ours, and it has always been the pane's own lifecycle
            // colour: blue while the agent works, green when it is done, the
            // plain accent when it is idle. A flat brand green here belonged to
            // no state at all.
            const sendColor = headerLifecycle === 'idle' || headerLifecycle === 'unknown' ? theme.colors.accent : headerStatus.color;
            const sendAction = railEnd(<Pressable onPress={sendPrompt} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }}
                style={({ pressed }) => ({ ...endCircle(pressed, canSend ? sendColor : withAlpha(theme.colors.text, 0.08)), opacity: canSend ? (pressed ? 0.8 : 1) : 0.55, transform: [{ scale: pressed && canSend ? 0.94 : 1 }] })}>
                <Ionicons name="send" size={17} color={canSend ? theme.colors.terminalChrome.canvas : theme.colors.textSecondary} style={{ marginLeft: 1 }} />
            </Pressable>);
            // 31669's trailing control: one circle at the rail's end. With
            // nothing to send it is the realtime agent, beside the microphone
            // the way every other app puts it; the moment there IS something to
            // send it gives way to send. Which of the two shows is decided by
            // the draft and its attachments alone — never by focus or by the
            // keyboard being up, so an empty field with the keyboard open still
            // offers the agent.
            //
            // The control is product code. It used to be drawn through the
            // composer plugin slot, and when realtime voice moved out of that
            // plugin and into the app the slot's contribution list emptied, so
            // the empty state silently fell through to a disabled send. Third
            // party contributions keep their own row in the pane menu.
            const readyToSend = draft.trim() !== '' || attachedPaths.length > 0 || selectedImages.length > 0;
            const trailingAction = !readyToSend && canControl
                ? railEnd(<View style={endCircle(false)}>
                    <RealtimeTalkButton sessionId={props.id} accessibilityLabel="Talk to this session" size={RAIL_END} />
                </View>)
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
                <View collapsable={false} style={{ flex: 1, backgroundColor: theme.colors.terminalChrome.canvas, paddingTop: insets.top, paddingBottom: keyboardVisible ? keyboardHeight : 0 }}>
                    {watchingWorkingAgent && <ActiveAgentWakeLock />}

                    {/* One quiet line above the terminal plane: a back mark,
                        the session identity, the pane pager, and an overflow
                        mark. No border, no shadow, no height it does not need —
                        only the chrome ink, which is just enough to see where
                        the terminal starts without the header becoming a band. */}
                    <Animated.View
                        onLayout={(event) => { if (!hasStatusRow) setHeaderBottom(event.nativeEvent.layout.y + event.nativeEvent.layout.height); }}
                        style={[{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 2,
                            paddingHorizontal: 6,
                            paddingTop: 0,
                            backgroundColor: theme.colors.terminalChrome.chrome,
                        }, ringRecede]}
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
                            style={({ pressed }) => ({ minWidth: 32, minHeight: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 1, paddingHorizontal: 4, borderRadius: 999, opacity: pressed ? 0.6 : 1 })}
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
                            {artifactsCount !== null && artifactsCount > 0 && <View style={{ position: 'absolute', top: 1, right: 0, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accent }}>
                                <Text style={{ color: theme.colors.surface, fontSize: 9, fontWeight: '700' }}>{artifactsCount > 99 ? '99+' : artifactsCount}</Text>
                            </View>}
                        </Pressable>}
                    </Animated.View>

                    {hasStatusRow && (
                        <Pressable
                            onLayout={(event) => setHeaderBottom(event.nativeEvent.layout.y + event.nativeEvent.layout.height)}
                            accessibilityRole="button"
                            accessibilityLabel="Review changes"
                            disabled={branch === null}
                            onPress={() => { if (branch !== null) router.push(`/session/${encodeURIComponent(props.id)}/changes`); }}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 4, backgroundColor: theme.colors.terminalChrome.chrome }}>
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
                        // A new object every layout would re-render this whole
                        // screen on each one, and layout fires repeatedly while
                        // the keyboard is arriving — the transition he called
                        // janky. Only a box that actually moved is reported.
                        onLayout={({ nativeEvent }) => {
                            const next = { top: nativeEvent.layout.y, width: nativeEvent.layout.width, height: nativeEvent.layout.height };
                            setTerminalBox((current) => (current !== undefined
                                && Math.abs(current.top - next.top) < 0.5
                                && Math.abs(current.width - next.width) < 0.5
                                && Math.abs(current.height - next.height) < 0.5 ? current : next));
                        }}
                        onTouchStart={(event) => {
                            const touch = event.nativeEvent.touches[0];
                            if (touch !== undefined) terminalTouch.current = { x: touch.locationX, y: touch.locationY };
                            paneGestures.onTouchStart(event);
                        }}
                        onTouchMove={paneGestures.onTouchMove}
                        onTouchEnd={paneGestures.onTouchEnd}
                        style={{ flex: 1 }}
                    >
                        <TerminalView key={attempt} sessionId={props.id} onStatus={onStatus} onChannel={onChannel} onViewControls={setViewControls} onLinkPress={showLinkActions} />
                        {linkMenu !== null && terminalBox !== undefined && terminalLinkCardFits(terminalBox.height, linkActions.length) && (
                            <TerminalLinkMenu
                                url={linkMenu.url}
                                at={linkMenu.at}
                                region={{ width: terminalBox.width, height: terminalBox.height }}
                                actions={linkActions}
                                onClose={() => setLinkMenu(null)}
                            />
                        )}
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

                    {/* Everything below the terminal is one surface in the
                        plane's own chrome ink: pane rail, key marks and
                        composer read as the same piece of chrome rather than as
                        three stacked bands, and the whole of it recedes
                        together while the ring is open. */}
                    <View style={{ backgroundColor: theme.colors.terminalChrome.chrome }}>

                    {/* Session/pane chip rail: one scrollable row of identity
                        chips for the open panes (or, across tabs, the other
                        tabs); the active chip carries close, a trailing + adds
                        a pane. It answers "which pane am I in", so it stays
                        while the keyboard is up and while dictation runs — that
                        is exactly when the question gets asked — and it stays
                        at one pane too, where it is the only way to add a
                        second. No band, no underline. */}
                    {treeLoaded && located !== undefined && (
                        <ScrollView
                            ref={tabStripRef}
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            keyboardShouldPersistTaps="always"
                            style={{ maxHeight: 30, backgroundColor: 'transparent' }}
                            contentContainerStyle={{ alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 0 }}
                        >
                            {workspaceTabs.length <= 1 || tabPanes.length > 1 ? tabPanes.map((pane) => {
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
                                            borderRadius: 999,
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
                                            borderRadius: 999,
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
                                style={({ pressed }) => ({ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                                <Ionicons name="add" size={15} color={theme.colors.textSecondary} />
                            </Pressable>}
                        </ScrollView>
                    )}

                    {canControl && <View>
                        {/* The key strip stands down while dictation owns the footer
                            with the keyboard up; the composer capsule stays. */}
                        {!(dictationActive && keyboardVisible) && <TerminalKeyRow channel={channel} onEdit={editKeys} onAction={onKeyAction}>{keySlot}</TerminalKeyRow>}

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
                            minHeight: RAIL_MEASURE,
                            // A pill, always: the radius is half the collapsed
                            // height, so the field keeps the rail's one round
                            // shape at every size instead of drifting toward a
                            // rounded box as it grows.
                            borderRadius: RAIL_MEASURE / 2,
                            backgroundColor: withAlpha(theme.colors.text, 0.07),
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingLeft: 0,
                            paddingRight: 4,
                            paddingVertical: FIELD_PAD,
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
                                    style={({ pressed }) => ({ ...inField, backgroundColor: withAlpha(theme.colors.status.error, pressed ? 0.28 : 0.18), transform: [{ scale: pressed ? 0.94 : 1 }] })}>
                                    <Ionicons name="stop" size={13} color={theme.colors.status.error} />
                                </Pressable>
                            </Animated.View> : transcribing ? <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                                <TranscribingDots color={theme.colors.textSecondary} />
                                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 15, marginLeft: 10 }}>Transcribing…</Text>
                                <Pressable onPress={dictation.cancel} accessibilityRole="button" accessibilityLabel="Cancel dictation"
                                    style={({ pressed }) => ({ ...inField, opacity: pressed ? 0.6 : 1 })}>
                                    <Ionicons name="close" size={19} color={theme.colors.textSecondary} />
                                </Pressable>
                            </Animated.View> : <>
                                {composerInput}
                                {clearAction}
                                {dictateAction}
                            </>}
                        </View>
                        {!dictationActive && trailingAction}
                    </View>
                    </View>}
                    </View>

                    {/* The one way into the terminal's quick actions: a control
                        floating on the terminal itself, resting where it was
                        last left, with the ring struck from wherever that is.
                        The overlay is exactly the terminal's own box, so the
                        arc can never reach the composer below it and the
                        control can never be dragged off the surface it belongs
                        to. */}
                    {hasTools && terminalBox !== undefined && floatingControlFits(terminalBox.height) && (
                        <View
                            pointerEvents="box-none"
                            onLayout={({ nativeEvent }) => setRingOverlay((current) => (Math.abs(current - nativeEvent.layout.height) < 0.5 ? current : nativeEvent.layout.height))}
                            style={{ position: 'absolute', left: 0, right: 0, top: terminalBox.top, bottom: 0 }}
                        >
                            <FloatingTerminalControls
                                ref={ringRef}
                                width={terminalBox.width}
                                height={Math.max(ringOverlay, terminalBox.height)}
                                terminalHeight={terminalBox.height}
                                slots={ringSlots}
                                clusterKeys={clusterKeys}
                                dim={ringDim}
                            />
                        </View>
                    )}

                    <TerminalControlGrid
                        visible={controlGrid.open}
                        category={controlGrid.category}
                        onCategoryChange={(category) => setControlGrid((current) => ({ ...current, category }))}
                        onClose={() => setControlGrid((current) => ({ ...current, open: false }))}
                        entries={rowEntries}
                        seed={rowSeed}
                        onChange={setRowEntries}
                        actions={storedActions}
                        actionSeed={quickActions}
                        onActionsChange={setStoredActions}
                        recentLinks={recentTerminalLinks(props.id)}
                        onRecentLink={(url, action) => {
                            setControlGrid((current) => ({ ...current, open: false }));
                            if (action === 'open') openTerminalLink(url, openExternalUrl);
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
                                    <TerminalMenuQuickActions slots={ringSlots} terminalHeight={terminalBox?.height} hasTools={hasTools} onClose={() => setActionsOpen(false)} />
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
                                    {/* One entry, not one per action: choosing a
                                        link then offers the same Open / Copy /
                                        Insert a long press on that link does. */}
                                    {recentTerminalLinks(props.id).length > 0 && <Pressable onPress={showRecentLinks} accessibilityRole="button" accessibilityLabel="Recent links"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="link-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Recent links</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>}
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
                                    {/* Keys, snippets, recent links, type size and the
                                        keyboard are five categories of ONE editor, and five
                                        rows here opening the same screen at different tabs
                                        was the menu repeating itself. One row now; the
                                        editor's own category rail does the rest. */}
                                    <Text style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>View</Text>
                                    <Pressable onPress={() => openControls(canControl ? 'keys' : 'appearance')} accessibilityRole="button" accessibilityLabel="Terminal controls"
                                        accessibilityHint="Keys, snippets, recent links, type size and the keyboard"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="options-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Terminal controls</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>
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

                    {visibleMenu !== null && (
                        <Pressable
                            onPress={() => { setMenu(null); setLinkMenu(null); }}
                            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
                        >
                            <View style={{ backgroundColor: theme.colors.surface, paddingBottom: insets.bottom + 8, borderTopLeftRadius: 14, borderTopRightRadius: 14 }}>
                                <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 }}>
                                    <Text style={{ color: theme.colors.text, fontWeight: '600', fontSize: 16 }}>{visibleMenu.title}</Text>
                                    {visibleMenu.note !== undefined && (
                                        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 }}>{visibleMenu.note}</Text>
                                    )}
                                </View>
                                <ScrollView style={{ maxHeight: 380 }}>
                                    {visibleMenu.items.map((item) => (
                                        <Pressable
                                            key={item.label}
                                            onPress={() => {
                                                setMenu(null);
                                                setLinkMenu(null);
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
                                <Pressable onPress={() => { setMenu(null); setLinkMenu(null); }} style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
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
