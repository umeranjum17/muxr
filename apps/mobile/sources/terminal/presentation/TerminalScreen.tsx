/**
 * The session screen: a live terminal, not a transcript.
 *
 * Herdr backs every agent CLI, so there is no per-agent transcript to render --
 * what the agent draws is what you see, and the keys you would press at the desk
 * are the ones the toolbar sends. Approvals happen in the terminal itself.
 */

import * as React from 'react';
import { ActivityIndicator, AppState, BackHandler, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { storage, useHerdrTree, useLocalSettingMutable, usePairingFailure, useSession, useSessionGitStatus, useSessions, useSocketStatus } from '@/catalog/store';
import { sessionStop } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { resolveMessageModeMeta } from '@/catalog/infrastructure/messageMeta';
import { recordAgentGate, recordTrackedRpc } from '@/catalog/infrastructure/connectionDiagnostics';
import { permissionModeChip, resolveStatusBarGitBranch } from '../domain/sessionStatusBar';
import { SessionMetaLine } from '@/herd/ui';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import type { HerdrTreeTab } from '@muxr/contract';
import { PaneOverviewSheet } from '@/herd/ui';
import type { TerminalViewControls } from './TerminalView';
// The xterm/Ghostty view stays out of the initial load graph: the session
// shell paints first, the terminal implementation streams in behind it.
const TerminalView = React.lazy(() => import('./TerminalView').then((module) => ({ default: module.TerminalView })));
import { usePaneGestures } from '../application/usePaneGestures';
import { useWebImeComposing } from '@/components/useWebImeComposing';
import { useWebBackCloses } from '@/components/useWebBackCloses';
import { AgentGlyph } from '@/components/AgentGlyph';
import { ActionShortcut } from '@/components/ActionShortcut';
import { AnimatedPopup } from '@/components/AnimatedOverlay';
import { agentLabels, agentNameLine, agentStatusColor, herdrPaneForSession, herdrTabForSession, isShellLabels, resolveTabPane, rememberPaneSelection, tabLabel, useNavigateToSession } from '@/herd';
import { terminalPaneCanSend, terminalPaneStatus } from '../domain/promptAvailability';
import type { TerminalChannel } from '../application/OpenTerminal';
import { ComposerAttachments } from '@/components/ComposerAttachments';
import { useAttachmentUploads } from '../application/useAttachmentUploads';
import { Typography } from '@/constants/Typography';
import { randomUUID } from 'expo-crypto';
import { targetKey, useSubmissions } from '@/catalog/application/submissions';
import { ComposerRecovery } from '@/terminal/application/composerRecovery';
import { composerDraft, useComposerDrafts } from '@/terminal/application/composerDrafts';
import { failureText, humanError } from '@/utils/errors';
import { nextWorkingAgentId, workingAgentSwipeIds } from '@/herd';
import { useSessionPlugins } from '@/plugins';
import { PluginSlot, DeclarativeSessionActions, useDeclarativeSessionActions, DeclarativeTerminalKeySlot } from '@/plugins/ui';
import type { SessionMenu } from '@/plugins';
import { FOOTER_ROW_HEIGHT, TOOLS_TRIGGER_INSET, TOOLS_TRIGGER_SIZE, TerminalToolsPanel, TerminalToolsTrigger } from './FloatingTerminalControls';
import { DictationStrip } from './DictationStrip';
import { FindOutputSheet } from './FindOutputSheet';
import { recentTerminalLinks } from '../application/recentOutput';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { resolvePluginText } from '@/plugins';
import { useDeviceAuthority } from '@/pairing';
import { displayLink } from '../domain/TerminalLink';
import { useTerminalChipLink } from '../application/useTerminalChipLink';
import { MOTION } from '@/constants/motion';

/** Shown while the terminal implementation streams in behind the shell. */
function TerminalViewFallback() {
    const { theme } = useUnistyles();
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        </View>
    );
}

/**
 * The session is one dark surface: the terminal paints dark whatever the app
 * theme, so everything around it -- header, strip, composer, keys, Tools and
 * every sheet they open -- reads the dark theme too. The scope sits at this
 * screen's own render root and the theme is read beneath it, so each render of
 * the screen (and everything it mounts) paints from the same palette.
 */
function DarkSurface({ children }: { children: (theme: ReturnType<typeof useUnistyles>['theme']) => React.ReactNode }): React.JSX.Element {
    const { theme } = useUnistyles();
    return <>{children(theme)}</>;
}

/** One open surface (or the blank browser) as the session's pane actions list it. */
export interface SurfaceAction { key: string; icon: string; label: string; shown: boolean; disabledReason?: string; onPress: () => void }

export const TerminalScreen = React.memo((props: { id: string; machineId: string; surfaceActions?: SurfaceAction[] }) => {
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canControl = authority === 'control' && !authorityLoading;
    const insets = useSafeAreaInsets();
    // Keyboard height already covers the home indicator, so keeping the bottom
    // inset while it is up double-pads the composer.
    const keyboardVisible = useKeyboardState().isVisible;
    const keyboardHeight = useKeyboardState().height;
    // The keyboard controller has no native module on web, so the session
    // follows the visual viewport there instead. Any real keyboard
    // occlusion moves the layout — the composer, but also raw xterm focus,
    // which is a supported input path (term.onData) with its own hidden
    // textarea. Pinch zoom also shrinks the visual viewport, so the zoom
    // level tells them apart: a keyboard preserves it exactly, a pinch
    // changes it. The resting zoom is whatever scale reads with no
    // occlusion (and whatever it reads on the very first update, so a
    // mount with the keyboard already up still pads). This is the one
    // geometry system on web: exactly one of the two sources below ever
    // moves the layout.
    const [viewportOffset, setViewportOffset] = React.useState(0);
    const restZoomRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || window.visualViewport == null) return;
        const viewport = window.visualViewport;
        const update = () => {
            const occlusion = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
            if (occlusion === 0 || restZoomRef.current === null) restZoomRef.current = viewport.scale;
            setViewportOffset(viewport.scale === restZoomRef.current ? occlusion : 0);
        };
        update();
        viewport.addEventListener('resize', update);
        viewport.addEventListener('scroll', update);
        return () => {
            viewport.removeEventListener('resize', update);
            viewport.removeEventListener('scroll', update);
        };
    }, []);
    const keyboardPad = Platform.OS === 'web'
        ? viewportOffset
        : (keyboardVisible ? keyboardHeight : 0);
    const session = useSession(props.id);
    const sessions = useSessions();
    const { workspaces } = useHerdrTree();
    const storedPane = herdrPaneForSession(workspaces, props.id);
    const gitStatus = useSessionGitStatus(props.id);
    const pluginButtons = useSessionPlugins();
    const declaredActions = useDeclarativeSessionActions(session?.metadata?.path);
    // The quick-actions list has a fixed order -- Files, Changes, then the
    // Applications launcher -- keyed by the declarations' identities, never
    // by a label, whatever order the plugins were installed in.
    const quickActions = React.useMemo(() => {
        const order = ['muxr.code:files.open', 'muxr.code:changes', 'muxr.panes:tools-sheet'];
        const rank = (key: string): number => { const index = order.indexOf(key); return index === -1 ? order.length : index; };
        return declaredActions.filter((action) => action.quickAction).sort((left, right) => rank(left.key) - rank(right.key));
    }, [declaredActions]);
    const paneActions = React.useMemo(() => declaredActions.filter((action) => !action.quickAction), [declaredActions]);
    const [terminalKeyboardDisabled, setTerminalKeyboardDisabled] = useLocalSettingMutable('terminalKeyboardDisabled');
    const [pluginActionBusy, setExtensionActionBusy] = React.useState<string>();
    const [swipeNow, setSwipeNow] = React.useState(Date.now);
    React.useEffect(() => {
        const timer = setInterval(() => setSwipeNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);
    const swipeIds = React.useMemo(() => workingAgentSwipeIds(sessions, swipeNow), [sessions, swipeNow]);
    const [status, setStatus] = React.useState('connecting');
    const [openAttempt, setOpenAttempt] = React.useState(0);
    // The unsent draft lives in composerDrafts (per computer + session) so
    // it survives leaving this screen; this state mirrors it for rendering.
    const draftTarget = React.useMemo(() => ({ machineId: props.machineId, sessionId: props.id }), [props.machineId, props.id]);
    const [draft, setDraftState] = React.useState(() => composerDraft(draftTarget));
    const setDraft = React.useCallback((text: string) => {
        setDraftState(text);
        useComposerDrafts.getState().set(draftTarget, text);
    }, [draftTarget]);
    const [stopping, setStopping] = React.useState(false);
    // Latching modifiers apply to one toolbar key or typed character, then clear.
    // Modal.alert lays buttons out in a row: past three it collapses into
    // overlapping mush on a phone. Anything with more options uses this sheet.
    const [menu, setMenu] = React.useState<SessionMenu | null>(null);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    const [headerBottom, setHeaderBottom] = React.useState(0);
    const [viewControls, setViewControls] = React.useState<TerminalViewControls>({ commands: [], dismissKeyboard: () => {} });
    // Tools lives in the footer's reserved slot, docked to the hand's side;
    // open, it takes the composer and keys' place and never the terminal's.
    const [toolsOpen, setToolsOpen] = React.useState(false);
    const [terminalHeight, setTerminalHeight] = React.useState(0);
    const [toolsBlocked, setToolsBlocked] = React.useState(false);
    // Find in recent output: a sheet over the session, opened from the panel.
    const [findOpen, setFindOpen] = React.useState(false);
    // Focus in Herdr: one request, the menu stays open while it is pending,
    // a failure stays on the row until the next tap; nothing replays itself.
    const socketConnected = useSocketStatus().status === 'connected';
    const [focusPending, setFocusPending] = React.useState(false);
    const [focusFailure, setFocusFailure] = React.useState<string | null>(null);
    const [toolsSide, setToolsSide] = useLocalSettingMutable('terminalToolsSide');
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const { attaching, selectedImages, attachedImages, setAttachedImages, attachedPaths, failed: failedImages, retryFailed, discardFailed, pickImages, addImages } = useAttachmentUploads(
        props.machineId,
        props.id,
        (error) => Modal.alert('Attachment failed', `${humanError(error).message} The files are kept below; retry when the connection is back.`),
    );
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const [channel, setChannel] = React.useState<TerminalChannel>();
    const draftRef = React.useRef(draft);
    draftRef.current = draft;

    const composerRef = React.useRef<TextInput>(null);
    // Same IME hazard as the home dock: Enter confirms composition on web.
    // The composer mounts only under control and hosted authority resolves
    // after mount, so attachment follows canControl — a constant true would
    // attach to nothing and never re-run when the composer appears.
    const isComposingRef = useWebImeComposing(composerRef, canControl);


    const graphicsOwnsScroll = React.useRef(false);
    const stopWatchingGraphics = React.useRef<(() => void) | undefined>(undefined);
    React.useEffect(() => () => stopWatchingGraphics.current?.(), []);

    const onChannel = React.useCallback((channel: TerminalChannel | undefined) => {
        stopWatchingGraphics.current?.();
        stopWatchingGraphics.current = undefined;
        graphicsOwnsScroll.current = false;
        netScrollBack.current = 0;
        setShowJump(false);
        if (channel !== undefined) {
            stopWatchingGraphics.current = channel.onGraphics((active, _reason, surface) => {
                const ownsScroll = active && surface !== 'inline';
                if (ownsScroll === graphicsOwnsScroll.current) return;
                graphicsOwnsScroll.current = ownsScroll;
                netScrollBack.current = 0;
                setShowJump(false);
            });
            // Wrap scroll() to track how far back we've gone; the jump button
            // belongs to terminal history, not a browser's own scroll position.
            const rawScroll = channel.scroll.bind(channel);
            channel.scroll = (lines, at) => {
                if (!graphicsOwnsScroll.current) {
                    netScrollBack.current = Math.max(0, netScrollBack.current + lines);
                    setShowJump(netScrollBack.current > 3);
                }
                rawScroll(lines, at);
            };
        }
        channelRef.current = channel;
        setChannel(channel);
    }, []);

    const netScrollBack = React.useRef(0);
    const [showJump, setShowJump] = React.useState(false);
    const jumpToBottom = React.useCallback(() => {
        const channel = channelRef.current;
        if (channel === undefined || graphicsOwnsScroll.current) return;
        // Overshoot on purpose: herdr clamps the scroll at the live edge.
        channel.scroll(-(netScrollBack.current + 5000));
        netScrollBack.current = 0;
        setShowJump(false);
    }, []);

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
    const { loaded: treeLoaded } = useHerdrTree();
    const located = herdrTabForSession(workspaces, props.id);
    const currentTab = located?.tab;
    const workspaceTabs = located?.workspace.tabs ?? [];
    const siblings = React.useMemo(
        () => (currentTab?.panes ?? []).map((pane) => pane.sessionId).filter((id): id is string => id !== undefined),
        [currentTab],
    );
    const [overviewOpen, setOverviewOpen] = React.useState(false);
    const currentPane = storedPane;
    const showGestureHintRef = React.useRef<(text: string) => void>(() => undefined);
    const navigateToSession = useNavigateToSession();
    const tabStripRef = React.useRef<ScrollView>(null);
    const activeChipX = React.useRef(0);
    // A tab tap goes straight to a pane; a tab with nothing to open yet asks
    // the tree again instead of guessing.
    const openTab = React.useCallback((tab: HerdrTreeTab) => {
        if (located === undefined) return;
        const target = resolveTabPane(tab, { machineId: props.machineId, workspaceId: located.workspace.workspaceId });
        if (target === undefined) {
            showGestureHintRef.current(tab.panes.length === 0 ? 'Unavailable' : 'Starting…');
            void sync.refreshHerdTree().catch(() => undefined);
            return;
        }
        navigateToSession(target);
    }, [located, props.machineId, navigateToSession]);
    // Remember the pane this device is on, so its tab returns here.
    React.useEffect(() => {
        if (located === undefined) return;
        rememberPaneSelection({ machineId: props.machineId, workspaceId: located.workspace.workspaceId, tabId: located.tab.tabId }, props.id);
    }, [located, props.machineId, props.id]);
    // The active chip comes into view without reordering the strip.
    React.useEffect(() => {
        const timer = setTimeout(() => tabStripRef.current?.scrollTo({ x: Math.max(0, activeChipX.current - 48), animated: false }), 0);
        return () => clearTimeout(timer);
    }, [currentTab?.tabId, workspaceTabs.length]);
    const panePromptable = currentPane?.promptable === true;
    const paneKind = currentPane?.agentKind;
    const paneLifecycle = currentPane?.agentStatus;
    const paneMissing = currentPane === undefined || isShellLabels(agentLabels(currentPane));
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

    const { chipLink, chipKind, openChipLink } = useTerminalChipLink(props.id);
    const showLinkChip = canControl && chipLink !== undefined && chipKind !== undefined;

    const showRecentLinks = React.useCallback((action: 'open' | 'copy') => {
        const links = recentTerminalLinks(props.id);
        if (links.length === 0) return;
        setActionsOpen(false);
        setToolsOpen(false);
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

    // Browser Back and Escape close the menu instead of leaving the session.
    const closeActions = React.useCallback(() => setActionsOpen(false), []);
    useWebBackCloses(actionsOpen, closeActions, 'muxrSessionActions');
    const closeMenu = React.useCallback(() => setMenu(null), []);
    useWebBackCloses(menu !== null, closeMenu, 'muxrSessionMenu');
    const closeTools = React.useCallback(() => setToolsOpen(false), []);
    useWebBackCloses(toolsOpen, closeTools, 'muxrTerminalTools');
    // Opening Tools first takes the keyboard down -- the terminal's IME and
    // the composer's focus -- and shows the panel once the viewport has
    // settled, so it lands in the space the keyboard held and never over
    // output. A keyboard that will not go says so on the key instead.
    const keyboardUpRef = React.useRef(false);
    keyboardUpRef.current = keyboardPad > 0 || keyboardVisible;
    React.useEffect(() => { if (!keyboardUpRef.current) setToolsBlocked(false); }, [keyboardPad, keyboardVisible]);
    const openFind = React.useCallback(() => {
        setToolsOpen(false);
        setActionsOpen(false);
        setOverviewOpen(false);
        setMenu(null);
        setFindOpen(true);
    }, []);
    const openTools = React.useCallback(() => {
        setActionsOpen(false);
        setOverviewOpen(false);
        setMenu(null);
        viewControls.dismissKeyboard();
        Keyboard.dismiss();
        composerRef.current?.blur();
        const started = Date.now();
        const settle = (): void => {
            if (!keyboardUpRef.current) { setToolsBlocked(false); setToolsOpen(true); return; }
            if (Date.now() - started > 600) { setToolsBlocked(true); return; }
            setTimeout(settle, 50);
        };
        setTimeout(settle, 50);
    }, [viewControls]);

    // The action menu is a plain absolute View, not a modal, so Android's
    // hardware back would leave the screen instead of dismissing it.
    React.useEffect(() => {
        if ((menu === null && !actionsOpen && !toolsOpen) || Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setMenu(null);
            setActionsOpen(false);
            setToolsOpen(false);
            return true;
        });
        return () => subscription.remove();
    }, [actionsOpen, menu, toolsOpen]);

    // Submissions live outside this screen (submissions.ts), partitioned by
    // computer + session; ComposerRecovery owns, for this screen opening,
    // which one the composer holds and what a Send retries. Late outcomes
    // for a target that is not open wait for its own screen.
    const target = React.useMemo(() => ({ machineId: props.machineId, sessionId: props.id }), [props.machineId, props.id]);
    const submissions = useSubmissions((state) => state.byTarget[targetKey(target)]);
    const recovery = React.useMemo(() => new ComposerRecovery(target, {
        restore: (submission) => {
            // Recovery-owned text: shown, but not stored as a typed draft, so
            // a reopened screen restores the same submission (same identity)
            // instead of finding "typed" text it cannot attribute.
            draftRef.current = [submission.draft, draftRef.current].filter((part) => part !== '').join('\n');
            setDraftState(draftRef.current);
            setAttachedImages((previous) => [...submission.attachments, ...previous]);
            // Previews that never reached the host are uploaded afresh.
            if (submission.pendingUploads.length > 0) addImages(submission.pendingUploads);
        },
        clear: () => {
            draftRef.current = '';
            setDraft('');
            setAttachedImages([]);
        },
    }), [addImages, setAttachedImages, target]);
    React.useEffect(() => () => recovery.dispose(), [recovery]);
    // Attachments and previews occupy the composer as much as text does.
    const composerEmpty = draft === '' && attachedImages.length === 0 && selectedImages.length === 0 && !attaching;
    React.useEffect(() => { recovery.reconcile(composerEmpty); }, [composerEmpty, recovery, submissions]);

    // The agent is a TUI: it can only reach a file by having the path in its
    // prompt. But splicing that path into the draft the moment you attach
    // lands it in the middle of whatever you were typing, so paths ride as
    // chips and are appended once, at send.
    const sendPrompt = React.useCallback(() => {
        // A booting agent is not a refusal: the host holds the prompt until it
        // can accept it, so let the composer stay live and let the host answer.
        if (attaching || selectedImages.length > 0) return;
        void recovery.send(draftRef.current, attachedImages);
    }, [attachedImages, attaching, selectedImages.length, panePromptable, recovery]);

    const handleDraftChange = React.useCallback((text: string) => setDraft(text), []);

    // Moshi's pattern: the file lands on the host, the agent gets a path.
    // Paths go into the draft so the user can write around them before sending.
    const attachPhotos = React.useCallback(async () => {
        await pickImages();
    }, [pickImages]);


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
                Modal.alert(failureTitle, failureText(error), [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Retry', onPress: () => stopSession() },
                ]);
            });
    }, [props.id, siblings, shell]);
    // Ending work is the one deliberate act here: name what stops, ask once.
    // A broader close herdr insists on still asks its own, different question.
    const confirmStop = React.useCallback(() => {
        void Modal.confirm(
            shell ? `Close ${labels.taskTitle}?` : `Stop ${labels.taskTitle}?`,
            shell ? 'The shell running in this pane closes.' : 'The agent running in this pane stops and its pane closes.',
            { cancelText: 'Cancel', confirmText: shell ? 'Close pane' : 'Stop agent', destructive: true },
        ).then((confirmed) => { if (confirmed) stopSession(); });
    }, [shell, labels.taskTitle, stopSession]);

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

    const canSend = !attaching && selectedImages.length === 0 && terminalPaneCanSend(currentPane, draft.trim() !== '' || attachedPaths.length > 0);
    // Short-chrome mode, agreed with the mark-band owner: keyboard up and the
    // terminal squeezed under 200dp. Tabs and the composer chrome collapse so
    // the user still sees the terminal being typed into; the key strip stays
    // present, losing only its outer vertical padding. Computed once here;
    // both halves key off this. Never true with the keyboard down.
    const shortChrome = (keyboardPad > 0 || keyboardVisible) && terminalHeight < 200;
    // The phone's 270dp class: under 340 wide (the same line settings uses)
    // the five-across composer leaves ~46dp for the input and the
    // placeholder reads 'Typ'. There the input takes its own line; at 340
    // and up the single row below renders exactly as before.
    const compactComposer = windowWidth < 340;
    // The terminal container includes the output-clearance band. Keep the
    // full mark clearance whenever the measured container can afford it; in
    // a short viewport, leave one trigger-sized area for output and move the
    // closed mark into chrome below rather than reserving the whole band.
    const terminalInset = terminalHeight === 0
        ? TOOLS_TRIGGER_INSET
        : Math.min(TOOLS_TRIGGER_INSET, Math.max(0, terminalHeight - TOOLS_TRIGGER_SIZE));
    const compactTools = terminalHeight > 0 && terminalInset < TOOLS_TRIGGER_INSET;
    const hasTabStrip = workspaceTabs.length > 0 || showLinkChip;
    const showTabStrip = hasTabStrip && !shortChrome;
    const keyRowHeight = shortChrome ? 46 : FOOTER_ROW_HEIGHT;

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
    const paneIndex = siblings.indexOf(props.id);
    const showConnectingStatus = status !== 'live' && gestureHint === null && status === 'connecting';
    const showRetryStatus = status !== 'live' && gestureHint === null && status !== 'connecting';
    // A dead grant cannot be retried into life: the pill routes to re-pairing
    // instead. Everything else keeps the transport vocabulary, and raw open
    // failures read as a sentence.
    const pairingFailure = usePairingFailure();
    const grantFailure = pairingFailure === 'device-revoked' ? 'revoked'
        : pairingFailure === 'grant-expired' || /grant expired/i.test(status) ? 'expired'
            : undefined;
    const statusText = grantFailure === 'expired' ? 'Access expired · Pair again'
        : grantFailure === 'revoked' ? 'Access removed · Pair again'
            : /^(connecting|reconnecting|live|closed|disconnected)$/.test(status) || status.includes('another device') ? status
                : `${failureText(status)} Tap to retry.`;
    const retryTerminal = React.useCallback(() => {
        if (grantFailure !== undefined) {
            router.push(`/pair?source=settings&reason=${grantFailure}` as never);
            return;
        }
        // No channel means the first open failed; only a fresh open can help.
        if (channelRef.current === undefined) setOpenAttempt((attempt) => attempt + 1);
        else channelRef.current.reconnect(true);
    }, [grantFailure]);

    // Same shape as KeyboardAvoidingView, minus the animation: that padding
    // moves frame by frame and Ghostty reflows its whole grid on every size
    // change, which is the flicker. One step change, one reflow.
    //
    // The bar has to stay in flow below the terminal: Ghostty pads itself to sit
    // above the IME, and it measures the gap below itself to do it, so a bar
    // that floats over it gets counted as empty space and lands on the output.
    // What repeats while working, at the thumb: the pane's surfaces first,
    // then the declared quick actions (Files, Changes, Applications) and the
    // recent links; the terminal's own keyboard and zoom are the card's
    // strip above these rows. Find in recent output is inspection and lives
    // in the header with Git history and Usage: the card is sized to show
    // every row it has without a scroll, at 270dp too.
    const recentLinks = recentTerminalLinks(props.id);
    const toolsRows = (
        <>
            {(props.surfaceActions ?? []).map((action) => (
                <ActionShortcut
                    key={action.key}
                    label={action.label}
                    accessibilityLabel={`${action.shown ? 'Open' : 'Show'} ${action.label}${action.disabledReason === undefined ? '' : `, unavailable: ${action.disabledReason}`}`}
                    icon={action.icon as never}
                    disabled={action.disabledReason !== undefined}
                    onPress={() => { closeTools(); action.onPress(); }}
                />
            ))}
            <DeclarativeSessionActions actions={quickActions} sessionId={props.id} onNavigate={closeTools} presentation="shortcut" />
            {recentLinks.length > 0 && <>
                <ActionShortcut label="Open link" icon="open-outline" onPress={() => showRecentLinks('open')} />
                <ActionShortcut label="Copy link" icon="copy-outline" onPress={() => showRecentLinks('copy')} />
            </>}
        </>
    );

    return (
        <ScopedTheme name="dark"><DarkSurface>{(theme) => {
        const headerStatus = agentStatusColor(headerLifecycle, theme);
        // "Go" is the accent, never a lifecycle or destructive colour: red on
        // this screen means needs-you or stop, and the send button is neither.
        const sendColor = canSend ? theme.colors.accent : theme.colors.textSecondary;
        const renderJump = (compact: boolean): React.JSX.Element | null => {
            if (!showJump) return null;
            return (
                <Pressable
                    onPress={jumpToBottom}
                    // The compact Jump dock reserves its own 52dp slot beside
                    // the key strip; keep this target inside that slot too.
                    hitSlop={compact ? 3 : 10}
                    accessibilityRole="button"
                    accessibilityLabel="Jump to bottom"
                    style={({ pressed }) => ({
                        position: 'absolute',
                        [toolsSide === 'right' ? 'left' : 'right']: compact ? 8 : 14,
                        bottom: compact ? 3 : (terminalInset - 38) / 2,
                        width: 38,
                        height: 38,
                        borderRadius: 19,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.colors.surfaceHigh,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        opacity: pressed ? 0.7 : 1,
                    })}
                >
                    <Ionicons name="arrow-down-outline" size={20} color={theme.colors.text} />
                </Pressable>
            );
        };
        // Compact controls are legal only in the footer's edge slots. The
        // slots are layout siblings of the key ScrollView, never an overlay
        // over the tab strip or the full key row.
        const compactFooterDock = compactTools;
        const renderCompactFooterDock = (dockSide: ToolsSide, absolute = false): React.JSX.Element | null => {
            if (!compactFooterDock || (dockSide !== toolsSide && !showJump)) return null;
            const placement = absolute
                ? { position: 'absolute' as const, top: 0, [dockSide]: 0 }
                : { position: 'relative' as const };
            return (
                <View pointerEvents="box-none" style={{ ...placement, width: TOOLS_TRIGGER_INSET, height: keyRowHeight, flexShrink: 0, zIndex: 10 }}>
                    {dockSide === toolsSide
                        ? <TerminalToolsTrigger side={toolsSide} onSideChange={setToolsSide} onPress={toolsOpen ? closeTools : openTools}
                            blocked={toolsBlocked} expanded={toolsOpen} dimmed={showJump} />
                        : renderJump(true)}
                </View>
            );
        };
        return (
        // The keyboard's space comes off the bottom on both platforms -- the
        // native inset or the PWA's visual-viewport occlusion -- so the footer
        // and its Tools key stay immediately above the IME.
        <View style={{ flex: 1, backgroundColor: theme.colors.terminal.background, paddingTop: insets.top, paddingBottom: keyboardPad }}>

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
                <View accessible accessibilityLabel={`${contextTitle}. ${agentNameLine(labels)}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, minHeight: 44, paddingVertical: 4 }}>
                    <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={18} />
                    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>
                            {contextTitle}
                        </Text>
                        <Text numberOfLines={1} style={{ color: headerStatus.color, fontSize: 11 }}>
                            {agentNameLine(labels)}
                        </Text>
                    </View>
                </View>
                {/* Position in the tab and the way into the pane overview: its own
                    44dp target, present even for a one-pane tab so a new pane
                    stays reachable. Loading shows as such, never as 0/0. */}
                <Pressable
                    onPress={() => { setActionsOpen(false); setToolsOpen(false); setOverviewOpen(true); }}
                    disabled={!treeLoaded}
                    accessibilityRole="button"
                    accessibilityLabel={treeLoaded ? `Pane ${Math.max(paneIndex, 0) + 1} of ${Math.max(siblings.length, 1)}. Open panes.` : 'Panes loading'}
                    accessibilityState={{ expanded: overviewOpen, disabled: !treeLoaded }}
                    style={({ pressed }) => ({ minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 6, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}
                >
                    {treeLoaded
                        ? <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>{Math.max(paneIndex, 0) + 1}/{Math.max(siblings.length, 1)}</Text>
                        : <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                    <Ionicons name="chevron-down-outline" size={14} color={theme.colors.textSecondary} />
                </Pressable>
                {canControl && <Pressable onPress={() => { setToolsOpen(false); setActionsOpen((open) => !open); }} accessibilityRole="button" accessibilityLabel="Pane actions"
                    accessibilityState={{ expanded: actionsOpen }} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}>
                    <Ionicons name="ellipsis-vertical" size={20} color={theme.colors.textSecondary} />
                </Pressable>}
            </View>

            {hasStatusRow && (
                <View onLayout={(event) => setHeaderBottom(event.nativeEvent.layout.y + event.nativeEvent.layout.height)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingBottom: 7, backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
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
                </View>
            )}

            {Platform.OS === 'web' && !canControl && (
                <View style={{ paddingHorizontal: 12, paddingVertical: 7, backgroundColor: theme.colors.surfaceHigh, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, textAlign: 'center' }}>
                        View-only browser · terminal input and agent controls are disabled · expiry is shown in Settings › Connection
                    </Text>
                </View>
            )}

            {/* The grid keeps a measured inset above the container's bottom
                edge, so the mark on the terminal (and Jump to bottom) never
                has an output row underneath it when there is room. In a
                short viewport the inset yields output space and the controls
                move into the adjacent chrome. The open card still floats in
                this same container. */}
            <View
                ref={paneGestures.ref}
                onTouchStart={paneGestures.onTouchStart}
                onTouchMove={paneGestures.onTouchMove}
                onTouchEnd={paneGestures.onTouchEnd}
                onLayout={(event) => setTerminalHeight(event.nativeEvent.layout.height)}
                style={{ flex: 1, paddingBottom: terminalInset }}
            >
                <React.Suspense fallback={<TerminalViewFallback />}>
                    <TerminalView sessionId={props.id} onStatus={onStatus} onChannel={onChannel} onViewControls={setViewControls} attempt={openAttempt} />
                </React.Suspense>
                {toolsOpen && <Pressable accessibilityLabel="Close terminal quick actions" onPress={closeTools} style={StyleSheet.absoluteFill} />}
                {/* Connection changes are announced, not only coloured: the pill
                    is visual, this one line is for assistive tech. */}
                <Text accessibilityLiveRegion="polite" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}>
                    {`Terminal ${statusText}`}
                </Text>
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
                {showRetryStatus && (
                        <Pressable
                            onPress={retryTerminal}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={grantFailure !== undefined ? statusText : status.includes('another device') ? 'Take control from another device' : `Reconnect terminal. ${statusText}`}
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
                {!compactTools && renderJump(false)}
                {/* The way to this terminal's controls, where the thumb already
                    is. A mark at the edge, not a disc over the output; it dims
                    while the output is being read back. */}
                {!compactTools && <TerminalToolsTrigger side={toolsSide} onSideChange={setToolsSide} onPress={toolsOpen ? closeTools : openTools}
                    blocked={toolsBlocked} expanded={toolsOpen} dimmed={showJump} />}
                {toolsOpen && (
                    <TerminalToolsPanel commands={viewControls.commands} side={toolsSide} maxHeight={terminalHeight} onClose={closeTools}>
                        {toolsRows}
                    </TerminalToolsPanel>
                )}
            </View>

            {/* The workspace's tabs, for anyone who can look: a tap opens that
                tab's last pane this device chose, else its focused pane, else
                its first. The link the output is showing sits at the strip's
                end, in the chrome: nothing floats over terminal rows.
                Hidden in short-chrome mode: with the keyboard up and under
                200dp of terminal, the strip's 44dp buys almost three rows. */}
            {showTabStrip && (
            <View style={{ position: 'relative', flexDirection: 'row', alignItems: 'center', minHeight: 44, backgroundColor: theme.colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
                <ScrollView
                    ref={tabStripRef}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="always"
                    style={{ flex: 1, maxHeight: 44 }}
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
                                {singleLabels !== undefined && <AgentGlyph name={isShellLabels(singleLabels) ? 'shell' : singleLabels.agentKind ?? singleLabels.agentName} size={16} />}
                                <Text numberOfLines={1} style={{ flexShrink: 1, color: tone.color, fontSize: 11, fontWeight: active ? '600' : '400' }}>
                                    {label}
                                </Text>
                                {/* A split tab says how many panes it holds; no symbol
                                    that another row already uses for something else. */}
                                {singleLabels === undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>· {tab.panes.length}</Text>}
                            </Pressable>
                        );
                    })}
                </ScrollView>
                {showLinkChip && (
                    <Animated.View
                        entering={FadeIn.duration(MOTION.base).reduceMotion(ReduceMotion.System)}
                        exiting={FadeOut.duration(MOTION.exit).reduceMotion(ReduceMotion.System)}
                        style={{ maxWidth: '55%', paddingRight: 8, paddingLeft: 4 }}
                    >
                        <Pressable
                            onPress={openChipLink}
                            onLongPress={() => void Clipboard.setStringAsync(chipLink!).then(() => showGestureHint('Link copied'))}
                            accessibilityRole="button"
                            accessibilityLabel={`${chipKind === 'preview' ? 'Preview' : 'Open'} ${chipLink}`}
                            style={({ pressed }) => ({
                                minHeight: 44,
                                justifyContent: 'center',
                                opacity: pressed ? 0.6 : 1,
                            })}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider }}>
                                <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '600' }}>
                                    {chipKind === 'preview' ? 'Preview' : 'Open'}
                                </Text>
                                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12, flexShrink: 1 }}>
                                    {displayLink(chipLink!, 48)}
                                </Text>
                            </View>
                        </Pressable>
                    </Animated.View>
                )}
            </View>
            )}

            {/* Footer: the key row, then the composer (for those who may type)
                last -- the keys never go below the input, and neither moves
                when the card is open: the card floats over the terminal
                above. */}
            <View style={{ position: 'relative', backgroundColor: theme.colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, paddingBottom: keyboardPad > 0 ? 0 : insets.bottom }}>
            {/* The key row sits above the composer and never below it. It stays
                visible while the IME is up because ctrl, Esc, Tab, ^C and ^D
                are typing actions. Short chrome drops only the row's outer
                6dp vertical padding; its Moshi caps remain 46dp. */}
            {canControl && (
                <View style={{ flexDirection: 'row', alignItems: 'center', height: keyRowHeight }}>
                    {renderCompactFooterDock('left')}
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="always"
                        style={{ flex: 1, maxHeight: keyRowHeight }}
                        // Moshi-measured strip: 7dp gaps, 10dp row inset, 58dp
                        // pitch. Single-row horizontal scroll, never wraps -- the
                        // content runs past the edge with a visible mid-cap cut,
                        // so more keys are never hidden without a cue. In compact
                        // mode the mark/Jump slots are layout siblings, not an
                        // overlay, so no key target sits beneath either control.
                        contentContainerStyle={{ minHeight: keyRowHeight, alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: shortChrome ? 0 : 6 }}
                    >
                        <DeclarativeTerminalKeySlot channel={channel} />
                    </ScrollView>
                    {renderCompactFooterDock('right')}
                </View>
            )}
            {/* The voice status strip: listening bars while dictating,
                frozen bars + spinner while transcribing. Gone when idle. */}
            {canControl && <DictationStrip />}
            {canControl && <>
            {failedImages.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
                    <Ionicons name="warning-outline" size={14} color={theme.colors.textDestructive} />
                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 12 }}>
                        {failedImages.length === 1 ? `${failedImages[0]!.name} didn't upload` : `${failedImages.length} files didn't upload`}
                    </Text>
                    <Pressable onPress={retryFailed} accessibilityRole="button" accessibilityLabel="Retry the failed uploads" hitSlop={8} style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 8 }}>
                        <Text style={{ color: theme.colors.textLink, fontSize: 13, ...Typography.default('semiBold') }}>Retry</Text>
                    </Pressable>
                    <Pressable onPress={discardFailed} accessibilityRole="button" accessibilityLabel="Discard the failed uploads" hitSlop={8} style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 8 }}>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Discard</Text>
                    </Pressable>
                </View>
            )}
            <ComposerAttachments
                images={[...attachedImages, ...selectedImages.filter((image) => !attachedImages.some((attached) => attached.id === image.id))]}
                onRemove={(id) => setAttachedImages((previous) => previous.filter((image) => image.id !== id))}
            />

            {/* Short-chrome composer: input plus Send on one 60dp line. Attach
                and the trailing mic/voice hide while the keyboard owns the
                screen; they are back the moment it dismisses. */}
            {shortChrome ? (
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: theme.colors.surface,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.colors.divider,
                }}
            >
                <TextInput
                    ref={composerRef}
                    value={draft}
                    onChangeText={handleDraftChange}
                    onSubmitEditing={() => {
                        if (!isComposingRef.current) sendPrompt();
                    }}
                    returnKeyType="send"
                    blurOnSubmit
                    submitBehavior="blurAndSubmit"
                    placeholder="Type a prompt…"
                    placeholderTextColor={theme.colors.textSecondary}
                    style={{
                        flex: 1,
                        // A web input has an intrinsic width; without this floor
                        // it refuses to shrink and pushes Send off a 390 screen.
                        minWidth: 0,
                        minHeight: 44,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.surfaceHigh,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                    }}
                />
                {/* The one filled control on the screen is the primary action's
                    button; the glyph in it stays in the outline register. */}
                <Pressable onPress={sendPrompt} hitSlop={8} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? sendColor : theme.colors.surfaceHigh }}>
                        <Ionicons name="arrow-up-outline" size={20} color={canSend ? theme.colors.button.primary.tint : theme.colors.textSecondary} />
                    </View>
                </Pressable>
            </View>
            ) : compactComposer ? (
            <View
                style={{
                    paddingHorizontal: 12,
                    paddingTop: 8,
                    paddingBottom: 8,
                    gap: 8,
                    backgroundColor: theme.colors.surface,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.colors.divider,
                }}
            >
                <TextInput
                    ref={composerRef}
                    value={draft}
                    onChangeText={handleDraftChange}
                    onSubmitEditing={() => {
                        if (!isComposingRef.current) sendPrompt();
                    }}
                    returnKeyType="send"
                    blurOnSubmit
                    submitBehavior="blurAndSubmit"
                    placeholder="Type a prompt…"
                    placeholderTextColor={theme.colors.textSecondary}
                    style={{
                        minHeight: 44,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.surfaceHigh,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                    }}
                />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Pressable onPress={attachPhotos} hitSlop={8} disabled={attaching} accessibilityRole="button" accessibilityLabel="Add attachment" accessibilityState={{ disabled: attaching }} style={{ opacity: attaching ? 0.4 : 1, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name={attaching ? 'hourglass-outline' : 'image-outline'} size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <PluginSlot slot="session.composer.trailing" context={{ sessionId: props.id, hasAgent: currentPane?.agentKind !== undefined, getText: () => draftRef.current, setText: setDraft }} />
                    </View>
                    {/* The one filled control on the screen is the primary action's
                        button; the glyph in it stays in the outline register. */}
                    <Pressable onPress={sendPrompt} hitSlop={8} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: 'auto' }}>
                        <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? sendColor : theme.colors.surfaceHigh }}>
                            <Ionicons name="arrow-up-outline" size={20} color={canSend ? theme.colors.button.primary.tint : theme.colors.textSecondary} />
                        </View>
                    </Pressable>
                </View>
            </View>
            ) : (
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: theme.colors.surface,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.colors.divider,
                }}
            >
                <Pressable onPress={attachPhotos} hitSlop={8} disabled={attaching} accessibilityRole="button" accessibilityLabel="Add attachment" accessibilityState={{ disabled: attaching }} style={{ opacity: attaching ? 0.4 : 1, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name={attaching ? 'hourglass-outline' : 'image-outline'} size={20} color={theme.colors.textSecondary} />
                </Pressable>
                <TextInput
                    ref={composerRef}
                    value={draft}
                    onChangeText={handleDraftChange}
                    onSubmitEditing={() => {
                        if (!isComposingRef.current) sendPrompt();
                    }}
                    returnKeyType="send"
                    blurOnSubmit
                    submitBehavior="blurAndSubmit"
                    placeholder="Type a prompt…"
                    placeholderTextColor={theme.colors.textSecondary}
                    style={{
                        flex: 1,
                        // A web input has an intrinsic width; without this floor
                        // it refuses to shrink and pushes Send off a 390 screen.
                        minWidth: 0,
                        minHeight: 44,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.surfaceHigh,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                    }}
                />
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <PluginSlot slot="session.composer.trailing" context={{ sessionId: props.id, hasAgent: currentPane?.agentKind !== undefined, getText: () => draftRef.current, setText: setDraft }} />
                </View>
                {/* The one filled control on the screen is the primary action's
                    button; the glyph in it stays in the outline register. */}
                <Pressable onPress={sendPrompt} hitSlop={8} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? sendColor : theme.colors.surfaceHigh }}>
                        <Ionicons name="arrow-up-outline" size={20} color={canSend ? theme.colors.button.primary.tint : theme.colors.textSecondary} />
                    </View>
                </Pressable>
            </View>
            )}
            </>}
            {/* View-only has no key strip to reserve a dock beside; retain the
                compact footer host for the trigger without stealing a key
                target. Controlled terminals use the sibling slots above. */}
            {compactFooterDock && !canControl && (
                <>
                    {renderCompactFooterDock('left', true)}
                    {renderCompactFooterDock('right', true)}
                </>
            )}
            </View>

            <PaneOverviewSheet visible={overviewOpen} sessionId={props.id} machineId={props.machineId} onClose={() => setOverviewOpen(false)} />
            <FindOutputSheet visible={findOpen} sessionId={props.id} keyboardPad={keyboardPad} onClose={() => setFindOpen(false)} />

            {/* Secondary actions belong to the header; view controls stay with the terminal. */}
            {actionsOpen && (
                <Animated.View
                    exiting={FadeOut.duration(MOTION.exit).reduceMotion(ReduceMotion.System)}
                    accessibilityViewIsModal
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20, alignItems: 'flex-end', justifyContent: 'flex-start' }}
                >
                    <Animated.View pointerEvents="none" entering={FadeIn.duration(MOTION.fast).reduceMotion(ReduceMotion.System)} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.18)' }} />
                    <Pressable onPress={() => setActionsOpen(false)} accessibilityLabel="Close pane actions" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
                    <AnimatedPopup style={{
                        flexShrink: 1,
                        minWidth: 236,
                        maxWidth: 320,
                        marginRight: 8,
                        marginLeft: 16,
                        marginTop: headerBottom + 8,
                        // Below the header and inside the upper two-thirds: the
                        // deliberate menu never becomes a second bottom sheet.
                        maxHeight: Math.max(200, windowHeight * 2 / 3 - headerBottom - 8),
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
                            {/* Occasional setup and inspection. Repeated work lives in the
                                footer's Tools; surfaces and links moved there. */}
                            {Platform.OS !== 'web' && (
                                <Pressable onPress={() => { setActionsOpen(false); setTerminalKeyboardDisabled(!terminalKeyboardDisabled); }} accessibilityRole="button"
                                    accessibilityLabel={terminalKeyboardDisabled ? 'Enable keyboard on tap' : 'Disable keyboard on tap'}
                                    style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                    <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{terminalKeyboardDisabled ? 'Enable keyboard on tap' : 'Disable keyboard on tap'}</Text>
                                </Pressable>
                            )}
                            <Text style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>Inspect</Text>
                            <DeclarativeSessionActions actions={paneActions} sessionId={props.id} onNavigate={() => setActionsOpen(false)} />
                            <Pressable onPress={() => { setActionsOpen(false); openFind(); }} accessibilityRole="button" accessibilityLabel="Find in recent output"
                                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Find in recent output</Text>
                            </Pressable>
                            {/* Returning the computer to this pane rearranges the
                                desktop: occasional, deliberate, and only with control. */}
                            <Text style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>Computer</Text>
                            <Pressable onPress={focusInHerdr} disabled={!socketConnected || focusPending} accessibilityRole="button"
                                accessibilityLabel={socketConnected ? 'Focus in Herdr' : 'Focus in Herdr, unavailable: not connected'}
                                accessibilityState={{ disabled: !socketConnected || focusPending, busy: focusPending }}
                                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh, opacity: socketConnected ? 1 : 0.5 })}>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ color: theme.colors.text, fontSize: 15 }}>Focus in Herdr</Text>
                                    {!socketConnected && <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>Not connected</Text>}
                                    {focusFailure !== null && <Text style={{ color: theme.colors.status.error, fontSize: 12, marginTop: 2 }}>{`Could not focus: ${focusFailure}. Tap to retry.`}</Text>}
                                </View>
                                {focusPending && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                            </Pressable>
                            {pluginButtons.length > 0 && <Text style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, color: theme.colors.textSecondary, fontSize: 12, fontWeight: '500' }}>Layout</Text>}
                            {pluginButtons.map((button) => {
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
                                    }).catch((error) => Modal.alert(`${button.name} failed`, humanError(error).message))
                                        .finally(() => setExtensionActionBusy(undefined));
                                }} disabled={pluginActionBusy !== undefined} accessibilityRole="button" accessibilityLabel={resolvePluginText(button.label)} accessibilityState={{ busy: pluginActionBusy === key, disabled: pluginActionBusy !== undefined }}
                                    style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                    {pluginActionBusy === key && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{resolvePluginText(button.label)}</Text>
                                </Pressable>;
                            })}
                        </ScrollView>
                        {/* Closing the pane is the one row here that destroys
                            something, so it never scrolls away and never sits in
                            the run of things you were only going to look at. */}
                        {!stopping && (
                            <Pressable onPress={() => { setActionsOpen(false); confirmStop(); }} accessibilityRole="button" accessibilityLabel={shell ? 'Close pane' : 'Stop agent'}
                                style={({ pressed }) => ({ minHeight: 44, marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
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
        </View>
        );
        }}</DarkSurface></ScopedTheme>
    );
});
