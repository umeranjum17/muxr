/**
 * The session screen: a live terminal, not a transcript.
 *
 * Herdr backs every agent CLI, so there is no per-agent transcript to render --
 * what the agent draws is what you see, and the keys you would press at the desk
 * are the ones the toolbar sends. Approvals happen in the terminal itself.
 */

import * as React from 'react';
import { ActivityIndicator, AppState, BackHandler, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { Modal } from '@/modal';
import { storage, useSession, useSessions } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { HerdrTreeTab } from '@muxr/contract';
import { TerminalView } from '@/terminal/TerminalView';
import { usePaneGestures } from '@/terminal/usePaneGestures';
import { StatusDot } from '@/components/StatusDot';
import { agentStatusColor } from '@/utils/sessionUtils';
import type { TerminalChannel } from '@/terminal/openTerminal';
import { useImagePicker } from '@/hooks/useImagePicker';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeBase64 } from '@/encryption/base64';
import { nextWorkingAgentId, workingAgentSwipeIds } from '@/utils/liveTerminalOrder';
import { useSessionPlugins } from '@/plugins/useSessionPlugins';
import { PluginSlot } from '@/plugins/PluginSlot';
import { DeclarativeChips, DeclarativeHeaderButtons, DeclarativeTerminalKeySlot } from '@/plugins/DeclarativePluginSlot';
import { useSlotContributions } from '@/plugins/useSlotContributions';
import type { SessionMenu } from '@/plugins/slotTypes';
import { resolvePluginText } from '@/plugins/pluginText';
import { randomUUID } from 'expo-crypto';

export const TerminalScreen = React.memo((props: { id: string }) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    // Keyboard height already covers the home indicator, so keeping the bottom
    // inset while it is up double-pads the composer.
    const keyboardVisible = useKeyboardState().isVisible;
    const keyboardHeight = useKeyboardState().height;
    const session = useSession(props.id);
    const sessions = useSessions();
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
    const [attachedPaths, setAttachedPaths] = React.useState<string[]>([]);
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
            channel.scroll = (lines) => {
                netScrollBack.current = Math.max(0, netScrollBack.current + lines);
                setShowJump(netScrollBack.current > 3);
                rawScroll(lines);
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

    // Transient hint so a gesture that found no neighbour doesn't feel dead.
    const [gestureHint, setGestureHint] = React.useState<string | null>(null);
    const hintTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const showGestureHint = React.useCallback((text: string) => {
        setGestureHint(text);
        if (hintTimer.current !== null) clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setGestureHint(null), 1400);
    }, []);

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
        if (menu === null || Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setMenu(null);
            return true;
        });
        return () => subscription.remove();
    }, [menu]);

    // The agent is a TUI: it can only reach a file by having the path in its
    // prompt. But splicing that path into the draft the moment you attach
    // lands it in the middle of whatever you were typing, so paths ride as
    // chips and are appended once, at send.
    const sendPrompt = React.useCallback(() => {
        const text = [draftRef.current.trim(), ...attachedPaths].filter((part) => part !== '').join(' ');
        if (text === '') return;
        // Empty the composer before the request so a second tap (or Enter plus
        // the send button) cannot double-submit. Restore on failure.
        const previousDraft = draftRef.current;
        const previousPaths = attachedPaths;
        draftRef.current = '';
        setDraft('');
        setAttachedPaths([]);
        void sync.sendMessage(props.id, text).catch((error: unknown) => {
            draftRef.current = previousDraft;
            setDraft(previousDraft);
            setAttachedPaths(previousPaths);
            Modal.alert('Send failed', error instanceof Error ? error.message : String(error));
        });
    }, [attachedPaths, props.id]);

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
                if (result.savedPaths.length > 0) {
                    setAttachedPaths((previous) => [...previous, ...result.savedPaths]);
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
        Modal.alert('Stop agent?', 'Closes this agent pane in herdr. The pane and its process are gone.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Stop',
                style: 'destructive',
                onPress: () => {
                    setStopping(true);
                    void sync
                        .request('session.stop', { sessionId: props.id })
                        .then(() => {
                            // Closing one pane of a tab should leave you in that
                            // tab, not eject you to the list. Prefer the pane
                            // after this one, fall back to the one before.
                            const index = siblings.indexOf(props.id);
                            const remaining = siblings.filter((id) => id !== props.id);
                            const next = remaining[index] ?? remaining[remaining.length - 1];
                            if (next === undefined) router.back();
                            else router.replace(`/session/${encodeURIComponent(next)}`);
                        })
                        .catch((error: unknown) => {
                            setStopping(false);
                            Modal.alert('Stop failed', error instanceof Error ? error.message : String(error));
                        });
                },
            },
        ]);
    }, [props.id, siblings]);

    // Mirrors sendPrompt's early return: nothing to send, nothing to press.
    const canSend = draft.trim() !== '' || attachedPaths.length > 0;

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
                    borderBottomWidth: 1,
                    borderBottomColor: theme.colors.divider,
                }}
            >
                <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back" style={{ padding: 4 }}>
                    <Ionicons name="chevron-back" size={20} color={theme.colors.text} />
                </Pressable>
                {(() => {
                    const currentTab = tabs.find((tab) => tab.tabId === tabId);
                    const currentPane = currentTab?.panes.find((pane) => pane.sessionId === props.id);
                    const contextTitle = currentPane?.label ?? currentTab?.label ?? currentPane?.agentName ?? currentPane?.agentKind ?? 'session';
                    const dot = agentStatusColor(currentTab?.agentStatus ?? 'unknown', theme);
                    const paneIndex = siblings.indexOf(props.id);
                    return (
                        <Pressable onPress={() => hasOverlay && setTreeOpen(true)} disabled={!hasOverlay} hitSlop={6} accessibilityRole="button" accessibilityLabel={overlayLabel} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, paddingVertical: 4 }}>
                            <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
                            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>
                                {contextTitle}
                            </Text>
                            {paneIndex !== -1 && siblings.length > 1 && (
                                <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>· {paneIndex + 1}/{siblings.length}</Text>
                            )}
                        </Pressable>
                    );
                })()}
                <View style={{ flex: 1 }} />
                {/* Same sheet as the title pressable — hidden from screen readers. */}
                {hasOverlay && (
                    <Pressable onPress={() => setTreeOpen(true)} hitSlop={10} accessible={false} accessibilityElementsHidden importantForAccessibility="no" style={{ padding: 4 }}>
                        <Ionicons name="list" size={19} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
                <PluginSlot slot="session.header.trailing" context={{ sessionId: props.id, cwd: session?.metadata?.path }} />
                <DeclarativeHeaderButtons cwd={session?.metadata?.path} />
                <DeclarativeChips slot="session.header.trailing" />
                {pluginButtons.length > 0 && (
                    <Pressable
                        onPress={() => setMenu({
                            title: 'Actions',
                            items: pluginButtons.map((button) => ({
                                label: resolvePluginText(button.label),
                                hint: button.name,
                                onPress: () => {
                                    const key = `${button.pluginId}:${button.id}`;
                                    if (pluginActionBusy !== undefined) return;
                                    setExtensionActionBusy(key);
                                    void sync.request('plugin.invoke', {
                                        pluginId: button.pluginId,
                                        manifestHash: button.manifestHash,
                                        contributionId: button.id,
                                        sessionId: props.id,
                                        idempotencyKey: randomUUID(),
                                    }).catch((error) => Modal.alert(`${button.name} failed`, error instanceof Error ? error.message : String(error)))
                                        .finally(() => setExtensionActionBusy(undefined));
                                },
                            })),
                        })}
                        disabled={pluginActionBusy !== undefined}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="More actions"
                        accessibilityState={{ disabled: pluginActionBusy !== undefined }}
                        style={{ padding: 4 }}
                    >
                        {pluginActionBusy === undefined
                            ? <Ionicons name="ellipsis-vertical" size={19} color={theme.colors.textSecondary} />
                            : <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                    </Pressable>
                )}
                <Pressable onPress={stopSession} hitSlop={10} disabled={stopping} accessibilityRole="button" accessibilityLabel="Stop agent" accessibilityState={{ disabled: stopping }} style={{ padding: 4 }}>
                    <Ionicons name="stop-circle-outline" size={19} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View
                ref={paneGestures.ref}
                onTouchStart={paneGestures.onTouchStart}
                onTouchMove={paneGestures.onTouchMove}
                onTouchEnd={paneGestures.onTouchEnd}
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
                {status !== 'live' && gestureHint === null && (
                    status === 'connecting' ? (
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
                    ) : (
                        // Stuck or dropped: the pill is the retry. A takeover
                        // reason makes the direct consequence explicit.
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
                    )
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

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                style={{ maxHeight: 52, backgroundColor: theme.colors.surface }}
                contentContainerStyle={{ alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6 }}
            >
                {/* Pills lead: the key toolbar is wider than a phone, so anything
                    after it is scrolled off-screen and effectively invisible. */}
                <PluginSlot slot="session.pills" context={{ sessionId: props.id }} />
                <DeclarativeChips slot="session.pills" />
                <DeclarativeTerminalKeySlot channel={channel} />
            </ScrollView>

            {attachedPaths.length > 0 && (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="always"
                    style={{ maxHeight: 40, backgroundColor: theme.colors.surface }}
                    contentContainerStyle={{ alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 6 }}
                >
                    {attachedPaths.map((path) => (
                        <Pressable
                            key={path}
                            onPress={() => setAttachedPaths((previous) => previous.filter((entry) => entry !== path))}
                            accessibilityLabel={`Remove attachment ${path}`}
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 4,
                                paddingHorizontal: 8,
                                paddingVertical: 4,
                                borderRadius: 12,
                                backgroundColor: theme.colors.surfaceHigh,
                            }}
                        >
                            <Ionicons name="image-outline" size={12} color={theme.colors.textSecondary} />
                            <Text style={{ color: theme.colors.text, fontSize: 12 }} numberOfLines={1}>
                                {path.split('/').pop()}
                            </Text>
                            <Ionicons name="close" size={12} color={theme.colors.textSecondary} />
                        </Pressable>
                    ))}
                </ScrollView>
            )}

            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    paddingBottom: (keyboardVisible ? 0 : insets.bottom) + 8,
                    backgroundColor: theme.colors.surface,
                }}
            >
                <Pressable onPress={attachPhotos} hitSlop={8} disabled={attaching} accessibilityRole="button" accessibilityLabel="Add attachment" accessibilityState={{ disabled: attaching }}>
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
                <PluginSlot slot="session.composer.trailing" context={{ sessionId: props.id, getText: () => draftRef.current, setText: setDraft }} />
                <Pressable onPress={sendPrompt} hitSlop={8} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend }} style={{ opacity: canSend ? 1 : 0.4 }}>
                    <Ionicons name="arrow-up-circle" size={30} color={theme.colors.text} />
                </Pressable>
            </View>

            <PluginSlot
                slot="session.overlay"
                context={{ sessionId: props.id, visible: treeOpen, onClose: () => setTreeOpen(false), openMenu: setMenu, showHint: showGestureHint }}
            />

            {menu !== null && (
                <Pressable
                    onPress={() => setMenu(null)}
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
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
                                    style={{ paddingHorizontal: 16, paddingVertical: 12 }}
                                >
                                    <Text style={{ color: theme.colors.text, fontSize: 15 }}>{item.label}</Text>
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
