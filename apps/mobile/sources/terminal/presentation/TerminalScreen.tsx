/**
 * The session screen: a live terminal, not a transcript.
 *
 * Herdr backs every agent CLI, so there is no per-agent transcript to render --
 * what the agent draws is what you see, and the keys you would press at the desk
 * are the ones the toolbar sends. Approvals happen in the terminal itself.
 */

import * as React from 'react';
import { ActivityIndicator, AppState, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, ReduceMotion, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { storage, useHerdrTree, useSession, useSessionGitStatus, useSessions } from '@/catalog/store';
import { sessionStop } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { resolveMessageModeMeta } from '@/catalog/infrastructure/messageMeta';
import { recordAgentGate, recordTrackedRpc } from '@/catalog/infrastructure/connectionDiagnostics';
import { permissionModeChip, resolveStatusBarGitBranch } from '../domain/sessionStatusBar';
import { SessionMetaLine } from '@/herd/ui';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import type { HerdrTreeTab } from '@muxr/contract';
import { TerminalView } from './TerminalView';
import { usePaneGestures } from '../application/usePaneGestures';
import { AgentGlyph } from '@/components/AgentGlyph';
import { AnimatedPopup } from '@/components/AnimatedOverlay';
import { agentAccessibilityLabel, agentLabels, agentNameLine, agentStatusColor, herdrPaneForSession, isShellLabels } from '@/herd';
import { terminalPaneCanSend, terminalPaneStatus } from '../domain/promptAvailability';
import type { TerminalChannel } from '../application/OpenTerminal';
import { useImagePicker } from '@/hooks/useImagePicker';
import { ComposerAttachments, type ComposerAttachment } from '@/components/ComposerAttachments';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';
import { nextWorkingAgentId, workingAgentSwipeIds } from '@/herd';
import { useSessionPlugins } from '@/plugins';
import { PluginSlot, DeclarativeSessionActions, DeclarativeTerminalKeySlot } from '@/plugins/ui';
import { useSlotContributions } from '@/plugins';
import type { SessionMenu } from '@/plugins';
import { recentTerminalLinks } from '../application/recentOutput';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { resolvePluginText } from '@/plugins';
import { randomUUID } from 'expo-crypto';
import { useDeviceAuthority } from '@/pairing';
import { displayLink } from '../domain/TerminalLink';

/**
 * The floating tools trigger: a small icon inside a target big enough to hit and
 * to drag. The circle is what you see, the box around it is what you press.
 *
 * It rests a jump button's height above the key row because the jump-to-bottom
 * control and the link chip already own that corner, and a default that lands on
 * top of them is a default nobody chose.
 */
const TOOLS_TARGET = 44;
const TOOLS_BASE = 60;
/** The gap between the trigger and the menu that hangs off it. */
const TOOLS_MENU_GAP = 6;
/** Room for roughly five rows: the least a menu can be and still be worth
 *  opening. The trigger stops climbing when the menu would fall below it. */
const TOOLS_MENU_MIN = 260;

export const TerminalScreen = React.memo((props: { id: string }) => {
    const { theme } = useUnistyles();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canControl = authority === 'control' && !authorityLoading;
    const insets = useSafeAreaInsets();
    // Keyboard height already covers the home indicator, so keeping the bottom
    // inset while it is up double-pads the composer.
    const keyboardVisible = useKeyboardState().isVisible;
    const keyboardHeight = useKeyboardState().height;
    const session = useSession(props.id);
    const sessions = useSessions();
    const { workspaces } = useHerdrTree();
    const storedPane = herdrPaneForSession(workspaces, props.id);
    const gitStatus = useSessionGitStatus(props.id);
    const pluginButtons = useSessionPlugins();
    const [pluginActionBusy, setExtensionActionBusy] = React.useState<string>();
    const [swipeNow, setSwipeNow] = React.useState(Date.now);
    React.useEffect(() => {
        const timer = setInterval(() => setSwipeNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);
    const swipeIds = React.useMemo(() => workingAgentSwipeIds(sessions, swipeNow), [sessions, swipeNow]);
    const [status, setStatus] = React.useState('connecting');
    const [draft, setDraft] = React.useState('');
    const [attaching, setAttaching] = React.useState(false);
    const [stopping, setStopping] = React.useState(false);
    // Latching modifiers apply to one toolbar key or typed character, then clear.
    // Modal.alert lays buttons out in a row: past three it collapses into
    // overlapping mush on a phone. Anything with more options uses this sheet.
    const [menu, setMenu] = React.useState<SessionMenu | null>(null);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    // The actions menu hangs above the keys, attachments and composer, and that
    // block changes height as attachments come and go.
    const [bottomBlockHeight, setBottomBlockHeight] = React.useState(0);
    React.useEffect(() => {
        if (!canControl) setBottomBlockHeight(0);
    }, [canControl]);
    // How far the tools trigger has been dragged up its edge, and how far it may
    // go: the terminal band only, never the header above or the keys below.
    const toolsLift = useSharedValue(0);
    const toolsLiftStart = useSharedValue(0);
    const toolsMaxLift = useSharedValue(0);
    // The menu reads that offset once, when it opens: nothing can drag the
    // trigger while the menu covering the screen is up.
    const [openLift, setOpenLift] = React.useState(0);
    const [attachedImages, setAttachedImages] = React.useState<ComposerAttachment[]>([]);
    const attachedPaths = attachedImages.flatMap((image) => image.path === undefined ? [] : [image.path]);
    // Other openable panes in this session's tab, in layout order. A pane only
    // gets a sessionId once herdr detects an agent in it, so bare shells are
    // absent -- they have nothing for the app to attach to.
    const [siblings, setSiblings] = React.useState<string[]>([]);
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const [channel, setChannel] = React.useState<TerminalChannel>();
    const draftRef = React.useRef(draft);
    draftRef.current = draft;

    const { selectedImages, pickImages, clearImages } = useImagePicker();

    const onChannel = React.useCallback((channel: TerminalChannel | undefined) => {
        if (channel !== undefined) {
            // Wrap scroll() to track how far back we've gone; the jump button
            // appears once you're a few lines into scrollback.
            const rawScroll = channel.scroll.bind(channel);
            channel.scroll = (lines, at) => {
                netScrollBack.current = Math.max(0, netScrollBack.current + lines);
                setShowJump(netScrollBack.current > 3);
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
        if (channel === undefined) return;
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

    const tabId = session?.metadata?.tabId;
    const [tabs, setTabs] = React.useState<readonly HerdrTreeTab[]>([]);
    const [treeOpen, setTreeOpen] = React.useState(false);
    const overlayContributions = useSlotContributions('session.overlay');
    const hasOverlay = overlayContributions.length > 0;
    const overlayLabel = overlayContributions[0]?.type === 'native' && overlayContributions[0].title !== undefined
        ? resolvePluginText(overlayContributions[0].title)
        : 'Session tools';
    const loadSiblings = React.useCallback(() => {
        if (tabId === undefined || tabId === '') return;
        void sync
            .request('herdr.tree', {})
            .then((tree) => {
                const tab = tree.workspaces.flatMap((workspace) => workspace.tabs).find((entry) => entry.tabId === tabId);
                setSiblings(
                    (tab?.panes ?? [])
                        .map((pane) => pane.sessionId)
                        .filter((id): id is string => id !== undefined),
                );
                const workspace = tree.workspaces.find((entry) => entry.workspaceId === session?.metadata?.workspaceId);
                // All tabs, shells included: the hierarchy sheet shows the
                // workspace as it is (agent-less tabs render dimmed).
                setTabs(workspace?.tabs ?? []);
            })
            .catch(() => undefined);
    }, [tabId, session?.metadata?.workspaceId]);
    React.useEffect(() => {
        loadSiblings();
    }, [loadSiblings, session?.metadata?.promptable]);
    const storedWorkspaceTabs = workspaces.find((entry) => entry.workspaceId === session?.metadata?.workspaceId)?.tabs;
    const currentTab = tabs.find((tab) => tab.tabId === tabId)
        ?? storedWorkspaceTabs?.find((tab) => tab.tabId === tabId);
    const fetchedPane = currentTab?.panes.find((pane) => pane.sessionId === props.id);
    const currentPane = fetchedPane ?? storedPane;
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
            loadSiblings();
            const timer = setInterval(loadSiblings, 15_000);
            return () => clearInterval(timer);
        }, [loadSiblings]),
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
        const previousDraft = draftRef.current;
        const previousImages = attachedImages;
        draftRef.current = '';
        setDraft('');
        setAttachedImages([]);
        void sync.sendMessage(props.id, text).catch((error: unknown) => {
            const restoredDraft = [previousDraft, draftRef.current].filter(Boolean).join('\n');
            draftRef.current = restoredDraft;
            setDraft(restoredDraft);
            setAttachedImages((current) => [...previousImages, ...current]);
            Modal.alert('Send failed', error instanceof Error ? error.message : String(error));
        });
    }, [attachedImages, attachedPaths, attaching, selectedImages.length, panePromptable, props.id]);

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

    const stopSession = React.useCallback(() => {
        setStopping(true);
        void sessionStop(props.id, {
            confirmClose: (prompt) => Modal.confirm(`${prompt.confirmText}?`, prompt.message, {
                cancelText: 'Cancel',
                confirmText: prompt.confirmText,
                destructive: true,
            }),
            confirmRetry: (message) => Modal.confirm('Could not stop agent', message, {
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
                Modal.alert('Could not stop agent', error instanceof Error ? error.message : String(error), [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Retry', onPress: () => stopSession() },
                ]);
            });
    }, [props.id, siblings]);

    const canSend = !attaching && selectedImages.length === 0 && terminalPaneCanSend(currentPane, draft.trim() !== '' || attachedPaths.length > 0);

    // Where this session sits and how it is allowed to act, in one quiet row.
    // Connection stays out of it: subtitle/send color and the reconnect pill
    // already say it, and saying it twice makes neither read.
    const branch = resolveStatusBarGitBranch(gitStatus?.branch, session?.metadata?.worktree?.branch, session?.metadata?.path);
    const permission = permissionModeChip(session === null || session === undefined ? null : resolveMessageModeMeta(session).permissionMode);
    const linesAdded = gitStatus !== null && gitStatus.linesAdded > 0 ? `+${gitStatus.linesAdded}` : null;
    const linesRemoved = gitStatus !== null && gitStatus.linesRemoved > 0 ? `−${gitStatus.linesRemoved}` : null;
    const hasStatusRow = branch !== null || linesAdded !== null || linesRemoved !== null || permission !== null;
    const labels = agentLabels(currentPane);
    const shell = isShellLabels(labels);
    const contextTitle = labels.taskTitle;
    const headerLifecycle = terminalPaneStatus(currentPane);
    const headerStatus = agentStatusColor(headerLifecycle, theme);
    // Working and done carry their lifecycle colour. Idle shares the
    // disconnected grey, which reads as dead on a ready agent.
    const sendColor = headerLifecycle === 'idle' ? theme.colors.accent : headerStatus.color;
    const paneIndex = siblings.indexOf(props.id);
    const showConnectingStatus = status !== 'live' && gestureHint === null && status === 'connecting';
    const showRetryStatus = status !== 'live' && gestureHint === null && status !== 'connecting';

    // Vertical drag only, clamped on the UI thread, so the trigger can be walked
    // off whatever output it covers without ever landing on the composer or
    // under the keyboard. The threshold is what keeps a tap a tap: below it the
    // pan never activates and the Pressable underneath gets its press, above it
    // gesture-handler takes the touch and the press is cancelled.
    const toolsPan = React.useMemo(() => Gesture.Pan()
        .enabled(!actionsOpen)
        .activeOffsetY([-8, 8])
        .onStart(() => { toolsLiftStart.set(toolsLift.get()); })
        .onUpdate((event) => {
            toolsLift.set(Math.min(Math.max(toolsLiftStart.get() - event.translationY, 0), toolsMaxLift.get()));
        }), [actionsOpen, toolsLift, toolsLiftStart, toolsMaxLift]);
    const toolsStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -toolsLift.get() }] }));

    // Same shape as KeyboardAvoidingView, minus the animation: that padding
    // moves frame by frame and Ghostty reflows its whole grid on every size
    // change, which is the flicker. One step change, one reflow.
    //
    // The bar has to stay in flow below the terminal: Ghostty pads itself to sit
    // above the IME, and it measures the gap below itself to do it, so a bar
    // that floats over it gets counted as empty space and lands on the output.
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.terminal.background, paddingTop: insets.top, paddingBottom: keyboardVisible ? keyboardHeight : 0 }}>

            <View
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
                <Pressable onPress={() => hasOverlay && setTreeOpen(true)} disabled={!hasOverlay} hitSlop={6} accessibilityRole="button" accessibilityLabel={overlayLabel} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, paddingVertical: 4 }}>
                    <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={18} />
                    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>
                            {contextTitle}
                        </Text>
                        <Text numberOfLines={1} style={{ color: headerStatus.color, fontSize: 11 }}>
                            {agentNameLine(labels)}
                        </Text>
                    </View>
                    {paneIndex !== -1 && siblings.length > 1 && (
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, flexShrink: 0 }}>· {paneIndex + 1}/{siblings.length}</Text>
                    )}
                </Pressable>
                {/* Same sheet as the title pressable — hidden from screen readers. */}
                {hasOverlay && (
                    <Pressable onPress={() => setTreeOpen(true)} hitSlop={8} accessible={false} accessibilityElementsHidden importantForAccessibility="no" style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.6 : 1 })}>
                        <Ionicons name="list-outline" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
            </View>

            {hasStatusRow && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingBottom: 7, backgroundColor: theme.colors.surface, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
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
                        View-only browser · terminal input and agent controls are disabled · access expires eight hours after pairing
                    </Text>
                </View>
            )}

            <View
                ref={paneGestures.ref}
                onTouchStart={paneGestures.onTouchStart}
                onTouchMove={paneGestures.onTouchMove}
                onTouchEnd={paneGestures.onTouchEnd}
                onLayout={(event) => {
                    // The menu hangs above the trigger, so the trigger's ceiling
                    // is really the menu's floor: it may climb only while a menu
                    // worth opening still fits over it. 12 is the popup's own top
                    // margin; the header it may also cover is not counted, so a
                    // short band gives up its travel rather than its menu.
                    //
                    // A keyboard or a row of attachments shrinks the band, so
                    // anything dragged past the new ceiling comes down with it.
                    const max = Math.max(0, event.nativeEvent.layout.height - TOOLS_BASE - TOOLS_TARGET - TOOLS_MENU_GAP - 12 - TOOLS_MENU_MIN);
                    toolsMaxLift.set(max);
                    if (toolsLift.get() > max) toolsLift.set(max);
                }}
                style={{ flex: 1 }}
            >
                <TerminalView sessionId={props.id} onStatus={onStatus} onChannel={onChannel} />
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
                            onPress={() => channelRef.current?.reconnect(true)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={status.includes('another device') ? 'Take control from another device' : `Reconnect terminal. ${status}`}
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
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{status}</Text>
                            <Ionicons name="refresh-outline" size={12} color={theme.colors.textSecondary} />
                        </Pressable>
                )}
                {showJump && (
                    <Pressable
                        onPress={jumpToBottom}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Jump to bottom"
                        style={({ pressed }) => ({
                            position: 'absolute',
                            right: 14,
                            bottom: 14,
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
                        <Ionicons name="arrow-down" size={18} color={theme.colors.text} />
                    </Pressable>
                )}
            </View>

            {canControl && <View onLayout={(event) => setBottomBlockHeight(event.nativeEvent.layout.height)} style={{ backgroundColor: theme.colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
            {siblings.length > 1 && (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="always"
                    style={{ maxHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider }}
                    contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 8 }}
                >
                    {siblings.map((siblingId) => {
                        const siblingPane = currentTab?.panes.find((pane) => pane.sessionId === siblingId);
                        const siblingLabels = agentLabels(siblingPane);
                        const siblingShell = isShellLabels(siblingLabels);
                        const siblingStatus = terminalPaneStatus(siblingPane);
                        const siblingTone = agentStatusColor(siblingStatus, theme);
                        const active = siblingId === props.id;
                        return (
                            <Pressable
                                key={siblingId}
                                onPress={active ? undefined : () => router.replace(`/session/${encodeURIComponent(siblingId)}`)}
                                accessibilityRole="button"
                                accessibilityLabel={`${active ? 'Current' : 'Open'} ${agentAccessibilityLabel(siblingLabels, siblingStatus)}`}
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
                                <AgentGlyph name={siblingShell ? 'shell' : siblingLabels.agentKind ?? siblingLabels.agentName} size={16} />
                                <Text numberOfLines={1} style={{ flexShrink: 1, color: siblingTone.color, fontSize: 11, fontWeight: active ? '600' : '400' }}>
                                    {siblingLabels.taskTitle}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            )}
            <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center' }}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="always"
                    style={{ flex: 1, maxHeight: 52 }}
                    contentContainerStyle={{ alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 6, paddingVertical: 6 }}
                >
                    <DeclarativeTerminalKeySlot channel={channel} />
                </ScrollView>
            </View>

            <ComposerAttachments
                images={[...attachedImages, ...selectedImages.filter((image) => !attachedImages.some((attached) => attached.id === image.id))]}
                onRemove={(id) => setAttachedImages((previous) => previous.filter((image) => image.id !== id))}
            />

            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    paddingBottom: (keyboardVisible ? 0 : insets.bottom) + 8,
                    backgroundColor: theme.colors.surface,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.colors.divider,
                }}
            >
                <Pressable onPress={attachPhotos} hitSlop={8} disabled={attaching} accessibilityRole="button" accessibilityLabel="Add attachment" accessibilityState={{ disabled: attaching }} style={{ opacity: attaching ? 0.4 : 1 }}>
                    <Ionicons name={attaching ? 'hourglass-outline' : 'image-outline'} size={24} color={theme.colors.textSecondary} />
                </Pressable>
                <TextInput
                    value={draft}
                    onChangeText={handleDraftChange}
                    onSubmitEditing={sendPrompt}
                    returnKeyType="send"
                    blurOnSubmit
                    submitBehavior="blurAndSubmit"
                    placeholder="Type a prompt…"
                    placeholderTextColor={theme.colors.textSecondary}
                    style={{
                        flex: 1,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.surfaceHigh,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                    }}
                />
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <PluginSlot slot="session.composer.trailing" context={{ sessionId: props.id, getText: () => draftRef.current, setText: setDraft }} />
                </View>
                <Pressable onPress={sendPrompt} hitSlop={8} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }} style={{ opacity: canSend ? 1 : 0.4 }}>
                    <Ionicons name="arrow-up-circle" size={30} color={sendColor} />
                </Pressable>
            </View>
            </View>}

            <PluginSlot
                slot="session.overlay"
                context={{ sessionId: props.id, visible: treeOpen, onClose: () => setTreeOpen(false), openMenu: setMenu, showHint: showGestureHint }}
            />

            {/* An actions menu, not a sheet: it belongs to the button that opened
                it, so it hangs off that corner, stays only as tall as it needs,
                and leaves the terminal visible behind it. The corner moves with
                the trigger -- a menu that stayed at the bottom while its button
                sat halfway up the screen would belong to nothing. */}
            {actionsOpen && (
                <Animated.View
                    exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)}
                    accessibilityViewIsModal
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20, alignItems: 'flex-end', justifyContent: 'flex-end' }}
                >
                    <Animated.View pointerEvents="none" entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.28)' }} />
                    <Pressable onPress={() => setActionsOpen(false)} accessibilityLabel="Close session actions" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
                    <AnimatedPopup style={{
                        flexShrink: 1,
                        minWidth: 236,
                        maxWidth: 320,
                        marginRight: 8,
                        marginLeft: 16,
                        marginTop: 12,
                        marginBottom: bottomBlockHeight + TOOLS_BASE + TOOLS_TARGET + TOOLS_MENU_GAP + openLift,
                        borderRadius: 14,
                        overflow: 'hidden',
                        // Rows carry the lighter fill; the surface behind them is
                        // only ever seen through the gap above the stop control.
                        backgroundColor: theme.colors.surface,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: theme.colors.divider,
                        transformOrigin: 'bottom right',
                        elevation: 12,
                    }}>
                        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} keyboardShouldPersistTaps="always">
                            <DeclarativeSessionActions cwd={session?.metadata?.path} sessionId={props.id} onNavigate={() => setActionsOpen(false)} />
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
                                    }).catch((error) => Modal.alert(`${button.name} failed`, error instanceof Error ? error.message : String(error)))
                                        .finally(() => setExtensionActionBusy(undefined));
                                }} disabled={pluginActionBusy !== undefined} accessibilityRole="button" accessibilityLabel={resolvePluginText(button.label)} accessibilityState={{ busy: pluginActionBusy === key, disabled: pluginActionBusy !== undefined }}
                                    style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                    {pluginActionBusy === key ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Ionicons name="extension-puzzle-outline" size={18} color={theme.colors.textSecondary} />}
                                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{resolvePluginText(button.label)}</Text>
                                </Pressable>;
                            })}
                        </ScrollView>
                        {/* Stopping the agent is the one row here that destroys
                            something, so it never scrolls away and never sits in
                            the run of things you were only going to look at. */}
                        {!stopping && (
                            <Pressable onPress={() => { setActionsOpen(false); stopSession(); }} accessibilityRole="button" accessibilityLabel="Stop agent"
                                style={({ pressed }) => ({ minHeight: 44, marginTop: 5, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh })}>
                                <Ionicons name="stop-circle-outline" size={18} color={theme.colors.status.error} />
                                <Text style={{ flex: 1, color: theme.colors.status.error, fontSize: 15 }}>Stop agent</Text>
                            </Pressable>
                        )}
                    </AnimatedPopup>
                </Animated.View>
            )}

            {/* Session tools: a small icon that floats over the terminal's right
                edge rather than sitting in the key row, where it was one more
                key cap. It starts above the keys and can be walked up the edge
                and left there, because the one place a fixed control is always
                wrong is on top of the line you are trying to read.

                It sits above its own menu's backdrop, so it stays lit as the
                thing the menu hangs off and a second press closes it, and below
                the option sheet, which is a sheet and owns the screen. */}
            {canControl && (
                <GestureDetector gesture={toolsPan}>
                    <Animated.View style={[{ position: 'absolute', right: 10, bottom: bottomBlockHeight + TOOLS_BASE, zIndex: 30 }, toolsStyle]}>
                        <Pressable
                            onPress={() => { setOpenLift(toolsLift.get()); setActionsOpen((open) => !open); }}
                            accessibilityRole="button"
                            accessibilityLabel="Session actions"
                            accessibilityState={{ expanded: actionsOpen }}
                            style={({ pressed }) => ({ width: TOOLS_TARGET, height: TOOLS_TARGET, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.75 : 1 })}
                        >
                            <View style={{
                                width: 34,
                                height: 34,
                                borderRadius: 17,
                                alignItems: 'center',
                                justifyContent: 'center',
                                backgroundColor: actionsOpen ? theme.colors.surfaceHighest : theme.colors.surfaceHigh,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: theme.colors.divider,
                                shadowColor: theme.colors.shadow.color,
                                shadowOffset: { width: 0, height: 2 },
                                shadowRadius: 6,
                                shadowOpacity: theme.colors.shadow.opacity,
                                elevation: 3,
                            }}>
                                <Ionicons name={actionsOpen ? 'construct' : 'construct-outline'} size={18} color={actionsOpen ? theme.colors.text : theme.colors.textSecondary} />
                            </View>
                        </Pressable>
                    </Animated.View>
                </GestureDetector>
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
});
