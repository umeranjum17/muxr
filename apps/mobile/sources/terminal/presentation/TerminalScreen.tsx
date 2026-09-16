/**
 * The session screen: a live terminal, not a transcript.
 *
 * Herdr backs every agent CLI, so there is no per-agent transcript to render --
 * what the agent draws is what you see, and the keys you would press at the desk
 * are the ones the toolbar sends. Approvals happen in the terminal itself.
 */

import * as React from 'react';
import { ActivityIndicator, AppState, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { changesList } from '@/catalog/ops';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { storage, useHerdrTree, useLocalSettingMutable, useSession, useSessionGitStatus, useSessions, useSocketStatus } from '@/catalog/store';
import { sessionStop } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { resolveMessageModeMeta } from '@/catalog';
import { recordAgentGate, recordTrackedRpc } from '@/catalog/diagnostics';
import { permissionModeChip, resolveStatusBarGitBranch } from '../domain/sessionStatusBar';
import { PaneOverviewSheet, SessionMetaLine } from '@/herd/ui';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import type { HerdrTreeTab } from '@muxr/contract';
import { TerminalView, type TerminalViewControls } from './TerminalView';
import { usePaneGestures } from '../application/usePaneGestures';
import { AgentGlyph } from '@/components/AgentGlyph';
import { ActionShortcut } from '@/components/ActionShortcut';
import { AnimatedPopup } from '@/components/AnimatedOverlay';
import { agentLabels, agentNameLine, agentStatusColor, herdrPaneForSession, herdrTabForSession, isShellLabels, rememberPaneSelection, resolveTabPane, tabLabel, useNavigateToSession } from '@/herd';
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
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';
import { nextWorkingAgentId, workingAgentSwipeIds } from '@/herd';
import { useSessionPlugins } from '@/plugins';
import { PluginSlot, DeclarativeSessionActions, useDeclarativeSessionActions, DeclarativeTerminalKeySlot } from '@/plugins/ui';
import { useSlotContributions } from '@/plugins';
import type { SessionMenu } from '@/plugins';
import { TerminalToolsPanel, TerminalToolsTrigger, TOOLS_FOOTER_WIDTH, type ToolsSide } from './FloatingTerminalControls';
import { recentTerminalLinks } from '../application/recentOutput';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { resolvePluginText } from '@/plugins';
import { randomUUID } from 'expo-crypto';
import { useDeviceAuthority } from '@/pairing';
import { useIsFocused } from '@react-navigation/native';
import { ActiveAgentWakeLock } from './ActiveAgentWakeLock';
import { getCachedConnectionSettings } from '@/connection';
import { displayLink } from '../domain/TerminalLink';
import { humanError } from '@/utils/errors';
import { CommandPalette } from '@/components/CommandPalette';
import type { Command } from '@/components/CommandPalette/types';
import { agentCommands } from '../domain/agentCommands';
import { FindOutputSheet } from './FindOutputSheet';
import { useTerminalQuickReplies } from '@/plugins/ui';

/**
 * The session is one dark surface: the terminal paints dark whatever the app
 * theme, so everything around it -- header, strip, composer, keys, Tools and
 * every sheet they open -- reads the dark theme too. The scope sits at this
 * screen's own render root and the theme is read beneath it, so each render
 * of the screen (and everything it mounts) paints from the same palette.
 */
function DarkSurface({ children }: { children: (theme: ReturnType<typeof useUnistyles>['theme']) => React.ReactNode }): React.JSX.Element {
    const { theme } = useUnistyles();
    return <>{children(theme)}</>;
}

export const TerminalScreen = React.memo((props: { id: string }) => {
    const compactComposer = useWindowDimensions().width < 380;
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
    const quickActions = React.useMemo(() => declaredActions.filter((action) => action.quickAction), [declaredActions]);
    const paneActions = React.useMemo(() => declaredActions.filter((action) => !action.quickAction), [declaredActions]);
    const quickReplies = useTerminalQuickReplies();
    const [changesCount, setChangesCount] = React.useState<number | null>(null);
    useFocusEffect(React.useCallback(() => {
        let cancelled = false;
        changesList(props.id)
            .then((badge) => { if (!cancelled) setChangesCount(badge.count); })
            .catch(() => { if (!cancelled) setChangesCount(null); });
        return () => { cancelled = true; };
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
    // Focus in Herdr: one request, the menu stays open while it is pending,
    // a failure stays on the row until the next tap; nothing replays itself.
    const [focusPending, setFocusPending] = React.useState(false);
    const [focusFailure, setFocusFailure] = React.useState<string | null>(null);
    const [headerBottom, setHeaderBottom] = React.useState(0);
    // The command panel is hosted by the pane, not by the terminal, so it can
    // cover the accessory key row while leaving the composer alone.
    const [viewControls, setViewControls] = React.useState<TerminalViewControls>({ commands: [], dismissKeyboard: () => {} });
    const [terminalBox, setTerminalBox] = React.useState<{ top: number; width: number; height: number }>();
    // The way to this terminal's quick actions: a labelled Tools control in
    // the footer, never a disc over the output. It docks on either footer
    // edge; the open card anchors above that slot.
    const [toolsSide, setToolsSide] = React.useState<ToolsSide>('right');
    const [toolsOpen, setToolsOpen] = React.useState(false);
    const [attachedImages, setAttachedImages] = React.useState<ComposerAttachment[]>([]);
    const attachedPaths = attachedImages.flatMap((image) => image.path === undefined ? [] : [image.path]);
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const [channel, setChannel] = React.useState<TerminalChannel>();
    const draftRef = React.useRef(draft);
    const composerRef = React.useRef<TextInput>(null);
    draftRef.current = draft;
    const insertDraft = React.useCallback((value: string) => {
        const next = [draftRef.current.trimEnd(), value].filter(Boolean).join(' ');
        draftRef.current = next;
        setDraft(next);
        // The palette animates out; focus once its input has released the IME.
        setTimeout(() => composerRef.current?.focus(), 280);
    }, []);
    const renderQuickActions = React.useCallback((close: () => void) => <>
        {Platform.OS !== 'web' && <ActionShortcut
            label={terminalKeyboardDisabled ? 'Enable keyboard on tap' : 'Disable keyboard on tap'}
            icon="keypad-outline"
            onPress={() => { setTerminalKeyboardDisabled(!terminalKeyboardDisabled); close(); }}
        />}
        {quickReplies.map((reply, index) => <ActionShortcut key={`${index}:${reply.label}`} label={reply.label} icon="chatbubble-ellipses-outline"
            accessibilityLabel={`Insert quick reply: ${reply.label}`} onPress={() => { insertDraft(reply.text); close(); }} />)}
        <ActionShortcut
            label={changesCount === null ? 'Review changes' : `Review changes · ${changesCount}`}
            icon="git-compare-outline"
            onPress={() => { close(); router.push(`/session/${encodeURIComponent(props.id)}/changes`); }}
        />
        <DeclarativeSessionActions actions={quickActions} sessionId={props.id} onNavigate={close} presentation="shortcut" />
    </>, [insertDraft, props.id, quickActions, quickReplies, setTerminalKeyboardDisabled, terminalKeyboardDisabled]);

    const { selectedImages, pickImages, clearImages } = useImagePicker();

    const graphicsOwnsScroll = React.useRef(false);
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
        graphicsOwnsScroll.current = false;
        scrollBack.current = 0;
        hostHasScrollback.current = false;
        altBack.current = 0;
        if (channel !== undefined) {
            setShowJump(false);
            const stopGraphics = channel.onGraphics((active) => {
                if (active === graphicsOwnsScroll.current) return;
                graphicsOwnsScroll.current = active;
                scrollBack.current = 0;
                hostHasScrollback.current = false;
                altBack.current = 0;
                setShowJump(false);
            });
            // A pane drawing its own image scrolls that image, so herdr's
            // viewport says nothing about what the eye is looking at.
            const stopScrollState = channel.onScrollState(({ offsetFromBottom, maxOffsetFromBottom }) => {
                if (graphicsOwnsScroll.current) return;
                if (maxOffsetFromBottom > 0) {
                    hostHasScrollback.current = true;
                    scrollBack.current = offsetFromBottom;
                    altBack.current = 0;
                    setShowJump(offsetFromBottom > 0);
                } else {
                    hostHasScrollback.current = false;
                    scrollBack.current = 0;
                    setShowJump(altBack.current > 0);
                }
            });
            const rawScroll = channel.scroll.bind(channel);
            channel.scroll = (lines, at) => {
                if (!graphicsOwnsScroll.current) {
                    altBack.current = Math.max(0, altBack.current + lines);
                    if (!hostHasScrollback.current) setShowJump(altBack.current > 0);
                }
                rawScroll(lines, at);
            };
            stopWatchingChannel.current = () => { stopGraphics(); stopScrollState(); };
        }
        channelRef.current = channel;
        setChannel(channel);
    }, []);
    const jumpToBottom = React.useCallback(() => {
        const channel = channelRef.current;
        if (channel === undefined || graphicsOwnsScroll.current) return;
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
    const showGestureHintRef = React.useRef<(text: string) => void>(() => undefined);
    const navigateToSession = useNavigateToSession();
    const tabStripRef = React.useRef<ScrollView>(null);
    const activeChipX = React.useRef(0);
    // The plugin tree sheet still mounts from the session header: the pane
    // overview answers "where am I", the overlay answers "what is around
    // me". Different header controls open each one.
    const [treeOpen, setTreeOpen] = React.useState(false);
    // Another modal owns the screen: the quick-actions card yields.
    React.useEffect(() => { if (actionsOpen || overviewOpen || treeOpen) setToolsOpen(false); }, [actionsOpen, overviewOpen, treeOpen]);
    const overlayContributions = useSlotContributions('session.overlay');
    const hasOverlay = overlayContributions.length > 0;
    const overlayLabel = overlayContributions[0]?.type === 'native' && overlayContributions[0].title !== undefined
        ? resolvePluginText(overlayContributions[0].title)
        : 'Session tools';
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
        if (terminalInputDisposition(currentPaneRef.current, sessionRef.current ?? undefined, '/model').kind === 'blocked') {
            showDialogGuard();
            return;
        }
        const known = agentCommands(paneKind);
        const entries: Command[] = known.map((entry) => ({
            id: entry.command,
            title: entry.command,
            subtitle: `${entry.description}${entry.arguments === undefined ? '' : ` · ${entry.arguments}`}`,
            category: 'Agent commands',
            actionLabel: 'Send now',
            action: () => sendCommand(entry.command),
            secondaryLabel: 'Edit',
            secondaryAction: () => insertDraft(`${entry.command} `),
        }));
        entries.push({
            id: 'custom-command', title: 'Custom command', subtitle: 'Type a slash command in the composer',
            category: 'Composer', actionLabel: 'Edit command', action: () => insertDraft('/'),
        });
        Modal.show({ component: CommandPalette, props: {
            appearance: 'terminal',
            title: known.length > 0 ? `${paneKind} · ${known.length} commands` : 'Unknown agent · type a command',
            commands: entries,
        } } as any);
    }, [canControl, insertDraft, paneKind, sendCommand, showDialogGuard]);
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
        // A booting agent is not a refusal: the host holds the prompt until it
        // can accept it, so let the composer stay live and let the host answer.
        if (attaching || selectedImages.length > 0) return;
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
    }, [attachedImages, attachedPaths, attaching, clearDraft, selectedImages.length, props.id, showDialogGuard]);

    const handleDraftChange = React.useCallback((text: string) => setDraft(text), []);

    // Moshi's pattern: the file lands on the host, the agent gets a path.
    // Paths go into the draft so the user can write around them before sending.
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

    const canSend = !attaching && selectedImages.length === 0 && terminalPaneCanSend(currentPane, draft.trim() !== '' || attachedPaths.length > 0);
    // The Tools card needs a view row or the key strip to be worth opening;
    // view-only keeps it too, so nothing that was reachable is lost.
    const hasTools = viewControls.commands.length > 0 || canControl;
    const closeTools = React.useCallback(() => setToolsOpen(false), []);
    const toolsRows = canControl && (Platform.OS !== 'web' || quickActions.length > 0 || quickReplies.length > 0) ? renderQuickActions : undefined;
    // Tools is a layout sibling of the key ScrollView, never an overlay over
    // the terminal output.
    const renderFooterDock = (dockSide: ToolsSide): React.JSX.Element | null => {
        if (!hasTools || dockSide !== toolsSide) return null;
        return (
            <View style={{ width: TOOLS_FOOTER_WIDTH, height: '100%', flexShrink: 0 }}>
                <TerminalToolsTrigger side={toolsSide} onSideChange={setToolsSide}
                    onPress={() => setToolsOpen((open) => !open)} expanded={toolsOpen} />
            </View>
        );
    };

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
    return (
        <ScopedTheme name="dark"><DarkSurface>{(theme) => {
            const headerStatus = agentStatusColor(headerLifecycle, theme);
            // Working and done carry their lifecycle colour. Idle shares the
            // disconnected grey, which reads as dead on a ready agent.
            const sendColor = headerLifecycle === 'idle' ? theme.colors.accent : headerStatus.color;
            const tabPanes = currentTab?.panes ?? [];
            const paneIndex = tabPanes.findIndex((pane) => pane.sessionId === props.id);
            const paneTotal = tabPanes.length;
            const showConnectingStatus = status !== 'live' && gestureHint === null && status === 'connecting';
            const showRetryStatus = status !== 'live' && gestureHint === null && status !== 'connecting' && status !== 'unconfirmed';
            const showUnconfirmedStatus = status === 'unconfirmed' && gestureHint === null;
            const attachmentAction = <Pressable onPress={attachPhotos} hitSlop={8} disabled={attaching} accessibilityRole="button" accessibilityLabel="Add attachment" accessibilityState={{ disabled: attaching }} style={{ opacity: attaching ? 0.4 : 1 }}>
                <Ionicons name={attaching ? 'hourglass-outline' : 'image-outline'} size={24} color={theme.colors.textSecondary} />
            </Pressable>;
            const commandAction = <Pressable onPress={openAgentCommands} accessibilityRole="button" accessibilityLabel="Agent commands" hitSlop={8} disabled={!canControl} accessibilityState={{ disabled: !canControl }}
                style={({ pressed }) => ({ width: 32, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent', opacity: canControl ? 1 : 0.4 })}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 23, fontWeight: '500' }}>/</Text>
            </Pressable>;
            const composerInput = <TextInput
                ref={composerRef}
                value={draft}
                onChangeText={handleDraftChange}
                onSubmitEditing={sendPrompt}
                returnKeyType="send"
                blurOnSubmit
                submitBehavior="blurAndSubmit"
                placeholder="Type a prompt…"
                placeholderTextColor={theme.colors.textSecondary}
                style={{ flex: 1, color: theme.colors.text, backgroundColor: theme.colors.surfaceHigh, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 }}
            />;
            const composerPlugins = <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <PluginSlot slot="session.composer.trailing" context={{ sessionId: props.id, getText: () => draftRef.current, setText: setDraft }} />
            </View>;
            const sendAction = <Pressable onPress={sendPrompt} hitSlop={8} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }} style={{ opacity: canSend ? 1 : 0.4 }}>
                <Ionicons name="arrow-up-circle" size={30} color={sendColor} />
            </Pressable>;
            // Only what the channel can vouch for: 'live' means frames flow with
            // nothing known wrong, so it reads as connected, never as health; a known
            // timeout or lost route reads unconfirmed until the host answers again.
            const statusText = status === 'live' ? 'connected'
                : status === 'unconfirmed' ? 'Connection unconfirmed'
                    : status;

            // Same shape as KeyboardAvoidingView, minus the animation: that padding
            // moves frame by frame and Ghostty reflows its whole grid on every size
            // change, which is the flicker. One step change, one reflow.
            //
            // The bar has to stay in flow below the terminal: Ghostty pads itself to sit
            // above the IME, and it measures the gap below itself to do it, so a bar
            // that floats over it gets counted as empty space and lands on the output.
                return (
                <View style={{ flex: 1, backgroundColor: theme.colors.terminal.background, paddingTop: insets.top, paddingBottom: keyboardVisible ? keyboardHeight : 0 }}>
                    {watchingWorkingAgent && <ActiveAgentWakeLock />}

                    <View
                        onLayout={(event) => { if (!hasStatusRow) setHeaderBottom(event.nativeEvent.layout.y + event.nativeEvent.layout.height); }}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            backgroundColor: theme.colors.surface,
                            // Header and status row are one chrome block: the edge
                            // belongs at its bottom, not between its two rows.
                            borderBottomWidth: hasStatusRow ? 0 : 1,
                            borderBottomColor: theme.colors.divider,
                        }}
                    >
                        <HeaderBackButton onPress={() => router.back()} style={{ marginLeft: -6 }} />
                        <Pressable onPress={() => hasOverlay && setTreeOpen(true)} disabled={!hasOverlay} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${contextTitle}. ${agentNameLine(labels)}. ${overlayLabel}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, minHeight: 44, paddingVertical: 4 }}>
                            <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={18} />
                            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                                <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>
                                    {contextTitle}
                                </Text>
                                <Text numberOfLines={1} style={{ color: headerStatus.color, fontSize: 11 }}>
                                    {agentNameLine(labels)}
                                </Text>
                            </View>
                            {hasOverlay && <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />}
                        </Pressable>
                        {/* Position in the tab and the way into the pane overview: its own
                            44dp target, present even for a one-pane tab so a new pane
                            stays reachable. Loading shows as such, never as 0/0. */}
                        <Pressable
                            onPress={() => { setActionsOpen(false); setOverviewOpen(true); }}
                            disabled={!treeLoaded || located === undefined}
                            accessibilityRole="button"
                            accessibilityLabel={treeLoaded && located !== undefined ? `Pane ${Math.max(paneIndex, 0) + 1} of ${Math.max(paneTotal, 1)}. Open panes.` : 'Panes loading'}
                            accessibilityState={{ expanded: overviewOpen, disabled: !treeLoaded || located === undefined }}
                            style={({ pressed }) => ({ minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 6, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}
                        >
                            {treeLoaded && located !== undefined
                                ? <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>{Math.max(paneIndex, 0) + 1}/{Math.max(paneTotal, 1)}</Text>
                                : <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                            <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
                        </Pressable>
                        <Pressable onPress={() => setFindOpen(true)} accessibilityRole="button" accessibilityLabel="Find in output" hitSlop={4}
                            style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}>
                            <Ionicons name="search" size={19} color={theme.colors.textSecondary} />
                        </Pressable>
                        {!authorityLoading && <Pressable onPress={() => setActionsOpen((open) => !open)} accessibilityRole="button" accessibilityLabel="Pane actions"
                            accessibilityState={{ expanded: actionsOpen }} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}>
                            <Ionicons name="ellipsis-vertical" size={20} color={theme.colors.textSecondary} />
                        </Pressable>}
                    </View>

                    {hasStatusRow && (
                        <Pressable
                            onLayout={(event) => setHeaderBottom(event.nativeEvent.layout.y + event.nativeEvent.layout.height)}
                            accessibilityRole="button"
                            accessibilityLabel="Review changes"
                            disabled={branch === null}
                            onPress={() => { if (branch !== null) router.push(`/session/${encodeURIComponent(props.id)}/changes`); }}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingBottom: 7, backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
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
                        <TerminalView sessionId={props.id} onStatus={onStatus} onChannel={onChannel} onViewControls={setViewControls} />
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
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{status}</Text>
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
                                    onPress={() => channelRef.current?.reconnect(true)}
                                    hitSlop={8}
                                    accessibilityRole="button"
                                    accessibilityLabel={status.includes('another device') ? 'Take control from another device' : `Reconnect terminal. ${statusText}`}
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

                    {/* The workspace's tabs, for anyone who can look: a tap opens that
                        tab's last pane this device chose, else its focused pane, else
                        its first. Same chip, same place; only the data changed. */}
                    {workspaceTabs.length > 0 && (
                        <ScrollView
                            ref={tabStripRef}
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            keyboardShouldPersistTaps="always"
                            style={{ maxHeight: 44, backgroundColor: theme.colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}
                            contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 8 }}
                        >
                            {workspaceTabs.map((tab, index) => {
                                const active = tab.tabId === currentTab?.tabId;
                                const single = tab.panes.length === 1 ? tab.panes[0] : undefined;
                                const singleLabels = single === undefined ? undefined : agentLabels(single);
                                const tone = agentStatusColor(tab.agentStatus, theme);
                                const label = tabLabel(tab, index);
                                return (
                                    <Pressable
                                        key={tab.tabId}
                                        onLayout={active ? ({ nativeEvent }) => { activeChipX.current = nativeEvent.layout.x; } : undefined}
                                        onPress={active ? undefined : () => openTab(tab)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`${active ? 'Current tab' : 'Open tab'} ${label}, ${tab.panes.length === 1 ? '1 pane' : `${tab.panes.length} panes`}`}
                                        accessibilityState={{ selected: active }}
                                        style={({ pressed }) => ({
                                            minHeight: 44,
                                            maxWidth: 180,
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            gap: 6,
                                            paddingHorizontal: 9,
                                            borderBottomWidth: 2,
                                            borderBottomColor: active ? theme.colors.accent : 'transparent',
                                            backgroundColor: active ? theme.colors.surfaceSelected : 'transparent',
                                            opacity: pressed ? 0.65 : 1,
                                        })}
                                    >
                                        {singleLabels !== undefined
                                            ? <AgentGlyph name={isShellLabels(singleLabels) ? 'shell' : singleLabels.agentKind ?? singleLabels.agentName} size={16} />
                                            : <Ionicons name="grid-outline" size={14} color={theme.colors.textSecondary} />}
                                        <Text numberOfLines={1} style={{ flexShrink: 1, color: tone.color, fontSize: 11, fontWeight: active ? '600' : '400' }}>
                                            {label}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </ScrollView>
                    )}

                    {canControl && <View style={{ backgroundColor: theme.colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
                    <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center' }}>
                        {renderFooterDock('left')}
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            keyboardShouldPersistTaps="always"
                            style={{ flex: 1, maxHeight: 52 }}
                            contentContainerStyle={{ alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 6, paddingVertical: 6 }}
                        >
                            <DeclarativeTerminalKeySlot channel={channel} />
                        </ScrollView>
                        {renderFooterDock('right')}
                    </View>

                    <ComposerAttachments
                        images={[...attachedImages, ...selectedImages.filter((image) => !attachedImages.some((attached) => attached.id === image.id))]}
                        onRemove={(id) => setAttachedImages((previous) => previous.filter((image) => image.id !== id))}
                    />

                    <View
                        style={{
                            flexDirection: compactComposer ? 'column' : 'row',
                            alignItems: compactComposer ? 'stretch' : 'center',
                            gap: 8,
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            paddingBottom: (keyboardVisible ? 0 : insets.bottom) + 8,
                            backgroundColor: theme.colors.surface,
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: theme.colors.divider,
                        }}
                    >
                        {compactComposer ? <>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{composerInput}{sendAction}</View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 4 }}>
                                {attachmentAction}{commandAction}<View style={{ flex: 1 }} />{composerPlugins}
                            </View>
                        </> : <>{attachmentAction}{commandAction}{composerInput}{composerPlugins}{sendAction}</>}
                    </View>
                    </View>}

                    {/* View-only has no key strip, but Tools still belongs in the
                        footer instead of floating over terminal output. */}
                    {!canControl && hasTools && (
                        <View style={{ height: 52, flexDirection: 'row', justifyContent: toolsSide === 'left' ? 'flex-start' : 'flex-end' }}>
                            {renderFooterDock(toolsSide)}
                        </View>
                    )}

                    {/* The open card floats over the terminal, anchored above the
                        Tools footer slot; a tap on the terminal closes it too. */}
                    {toolsOpen && terminalBox !== undefined && hasTools && (
                        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: terminalBox.top, height: terminalBox.height }}>
                            <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={closeTools} />
                            <TerminalToolsPanel commands={viewControls.commands} renderQuickActions={toolsRows}
                                dismissKeyboard={viewControls.dismissKeyboard} side={toolsSide}
                                width={terminalBox.width} maxHeight={terminalBox.height} onClose={closeTools} />
                        </View>
                    )}

                    <PaneOverviewSheet visible={overviewOpen} sessionId={props.id} onClose={() => setOverviewOpen(false)} />
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
                                    <Pressable onPress={() => { setActionsOpen(false); router.push(`/session/${encodeURIComponent(props.id)}/history`); }} accessibilityRole="button" accessibilityLabel="Conversation history"
                                        style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                        <Ionicons name="document-text-outline" size={18} color={theme.colors.textSecondary} />
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Conversation history</Text>
                                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    {canControl && <DeclarativeSessionActions actions={paneActions} sessionId={props.id} onNavigate={() => setActionsOpen(false)} />}
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
