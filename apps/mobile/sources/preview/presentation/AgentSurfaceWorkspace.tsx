import * as React from 'react';
import { BackHandler, Keyboard, Pressable, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { Modal } from '@/modal';
import { TerminalRoute } from '@/terminal/ui';
import { HostBrowserView } from '@/takeover/ui';
import { dismissSurfaceOffer, findSurfaceEntry, useSurfaceEntries, type SurfaceEntry } from '@/catalog';
import { useLocalSettingMutable } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { openFileViewer, pluginCatalogLoaded, pluginHref, pluginSnapshot, subscribePlugins } from '@/plugins';
import { useDeviceAuthority } from '@/pairing';
import { getCachedHostedGrant } from '@/pairing/e2ee';
import {
    DirectBrowserSurface,
    LocalBrowserSurface,
    surfaceProviderApproved,
    type SurfaceBackRegistration,
} from '@/preview/presentation/ProductSurfaceView';
import { clampSurfaceRatio, defaultSurfaceRatio, SURFACE_DIVIDER_ZONE_DP, surfaceLayoutForWindow } from '@/preview/application/surfaceLayout';
import { reportShownSurface, useSurfaceFocusRequest } from '@/preview/application/surfaceFocus';
import { surfaceIcon, surfaceLabel } from '@/preview/application/surfaceLabels';
import type { SurfaceAction } from '@/terminal/ui';
import { planSurfacePanes } from '@/preview/application/surfacePlacement';

/**
 * Adaptive Agent + Surface workspace.
 *
 * Wraps the existing session screen without rewriting it. One stable tree:
 * the terminal container and at most one surface container keep constant
 * keys and positions across width changes and focus toggles -- only
 * visibility and geometry flip. A hidden compact pane keeps full-bounds
 * nonzero layout (absolute, transparent), is non-interactive and is hidden
 * from accessibility; it is never `display:none`, which collapses native
 * surfaces. Selection keys on the logical surface name, never the handle,
 * because an update replaces the handle.
 *
 * - Compact (below 764dp wide): Agent is the default. Ready surfaces are
 *   listed where tools already live (the session's pane actions, the
 *   sidebar Tools); a tap focuses one. Offers never auto-select here.
 * - Wide (both axes at/above the threshold): an incoming Browser `beside`
 *   offer is selected and mounted beside the Agent without moving keyboard
 *   focus; the divider adjusts the split.
 *
 * Back has one owner (below): WebView history first, then Agent on compact;
 * wide without history falls through to normal session navigation.
 */

type Approval = { state: 'ready' } | { state: 'pending' } | { state: 'unavailable'; reason: string };

function approvalFor(entry: SurfaceEntry, authority: string, catalogTick: number): Approval {
    void catalogTick;
    if (authority !== 'control') return { state: 'unavailable', reason: 'View-only devices cannot open surfaces' };
    const offer = entry.offer;
    if (!pluginCatalogLoaded()) return { state: 'pending' };
    if (!surfaceProviderApproved(offer.provider, offer.capability)) {
        return { state: 'unavailable', reason: 'This surface provider is unavailable' };
    }
    return { state: 'ready' };
}

/** Touch target for the divider drag. The visible line stays 2dp. */
const DIVIDER_ZONE = SURFACE_DIVIDER_ZONE_DP;
const DIVIDER_STEP = 0.05;

const hiddenPaneStyle = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
};

/** Native Changes destination every Code review provider declares. */
const CODE_REVIEW_CONTENT_ID = 'changes.review';

export function AgentSurfaceWorkspace(props: { id: string }): React.JSX.Element {
    const { theme } = useUnistyles();
    const window = useWindowDimensions();
    // The workspace may not own the whole window: on a desktop browser a
    // sidebar takes part of it. Layout decisions and pane geometry follow
    // the measured container, with the window as the pre-layout estimate.
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const width = measuredWidth ?? window.width;
    const insets = useSafeAreaInsets();
    const { authority } = useDeviceAuthority();
    const machineId = getCachedConnectionSettings().machineId;
    // Pairing-time display name, never the internal machine id.
    const machineLabel = getCachedHostedGrant(machineId)?.machineName;
    const entries = useSurfaceEntries(machineId, props.id);
    const [catalogTick, bumpCatalog] = React.useReducer((count: number) => count + 1, 0);
    React.useEffect(() => subscribePlugins(bumpCatalog), []);
    const [storedRatio, setStoredRatio] = useLocalSettingMutable('surfaceSplitRatio');

    // Selection is the logical surface name; focus is the compact visible
    // pane. Store updates never move either, except the beside rule below.
    const [focus, setFocus] = React.useState<'agent' | 'surface'>('agent');
    const [selection, setSelection] = React.useState<string | null>(null);
    const [blankOpen, setBlankOpen] = React.useState(false);
    const [transientDirectUrl, setTransientDirectUrl] = React.useState<string | null>(null);

    const wide = surfaceLayoutForWindow(width) === 'wide';

    const approvals = React.useMemo(() => {
        const map = new Map<string, Approval>();
        for (const entry of entries) map.set(entry.handle, approvalFor(entry, authority, catalogTick));
        return map;
    }, [entries, authority, catalogTick]);

    const browserEntries = entries.filter((entry) => entry.offer.kind !== 'code-review');
    const codeEntries = entries.filter((entry) => entry.offer.kind === 'code-review');
    const selectedEntry = selection === null ? undefined : findSurfaceEntry(machineId, props.id, selection);
    const selectedApproval = selectedEntry === undefined ? undefined : approvals.get(selectedEntry.handle);

    // The selected name resolving to nothing (host close, expiry) returns
    // compact focus to the Agent without closing anything. The name stays
    // selected so a newer revision remounts beside the Agent on wide and
    // stays one tap away on compact; only an explicit Close clears it.
    React.useEffect(() => {
        if (selection !== null && selectedEntry === undefined && !wide) setFocus('agent');
    }, [selection, selectedEntry, wide]);

    // Wide honors an incoming Browser `beside` placement by selecting and
    // mounting it beside the Agent. This never moves keyboard focus and
    // never runs on compact, which stays dock-only until an explicit tap.
    React.useEffect(() => {
        if (!wide || selection !== null || blankOpen || transientDirectUrl !== null) return;
        let newest: SurfaceEntry | undefined;
        for (const entry of browserEntries) {
            if (entry.offer.placement !== 'beside') continue;
            if (approvals.get(entry.handle)?.state !== 'ready') continue;
            if (newest === undefined || entry.revision > newest.revision) newest = entry;
        }
        if (newest !== undefined) setSelection(newest.offer.name);
    }, [wide, selection, blankOpen, transientDirectUrl, browserEntries, approvals]);

    // One back owner for the active surface. History goes back only through
    // the registered handler -- never via effect-registration order. Then
    // compact returns to the Agent without closing; wide without history
    // falls through to normal session navigation.
    const surfaceBackRef = React.useRef<(() => boolean) | null>(null);
    const registerSurfaceBack = React.useCallback<SurfaceBackRegistration>((handler) => {
        surfaceBackRef.current = handler;
    }, []);
    const surfaceActive = selectedEntry !== undefined || blankOpen || transientDirectUrl !== null;
    React.useEffect(() => {
        if (!surfaceActive) return undefined;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (surfaceBackRef.current?.() === true) return true;
            if (!wide && focus === 'surface') {
                setFocus('agent');
                return true;
            }
            return false;
        });
        return () => subscription.remove();
    }, [surfaceActive, wide, focus]);

    const focusSurfaceName = React.useCallback((name: string) => {
        // The hidden composer must not keep IME focus: keystrokes would land
        // in a prompt the user cannot see.
        Keyboard.dismiss();
        setSelection(name);
        setBlankOpen(false);
        setTransientDirectUrl(null);
        setFocus('surface');
    }, []);

    const closeOffer = React.useCallback((entry: SurfaceEntry) => {
        dismissSurfaceOffer(entry.handle);
        setSelection((current) => (current === entry.offer.name ? null : current));
        setFocus('agent');
    }, []);

    const openCodeEntry = React.useCallback((entry: SurfaceEntry) => {
        if (entry.offer.kind !== 'code-review') return;
        if (entry.offer.destination === 'diff' || entry.offer.path === '.') {
            if (entry.offer.path !== '.') {
                // That file, opened in diff mode: same native viewer, explicit
                // initial mode, still review-only.
                router.push(openFileViewer({
                    sessionId: props.id,
                    path: entry.offer.path,
                    mode: 'diff',
                }));
                return;
            }
            // Targetless/root diff: the Changes destination of the exact
            // provider that made this offer -- never the first claimant,
            // never an unrelated plugin. The provider must currently approve
            // `surface.code.open` and declare the native Changes screen;
            // a missing mapping fails visibly instead of going nowhere.
            const holder = pluginSnapshot().find(
                (candidate) => candidate.summary.pluginId === entry.offer.provider
                    && candidate.summary.capabilities['surface.code.open'] !== undefined,
            );
            const declaresReview = holder?.manifest.contributions.some((contribution) =>
                contribution.slot === 'navigation.content'
                && (contribution as { id?: unknown }).id === CODE_REVIEW_CONTENT_ID);
            if (holder === undefined || declaresReview !== true) {
                Modal.alert('Code review unavailable', 'The surface provider no longer offers a review destination.');
                return;
            }
            router.push(pluginHref(holder.summary.pluginId, CODE_REVIEW_CONTENT_ID, { sessionId: props.id }));
            return;
        }
        router.push(openFileViewer({
            sessionId: props.id,
            path: entry.offer.path,
            ...(entry.offer.line === undefined ? {} : { line: entry.offer.line }),
            ...(entry.offer.column === undefined ? {} : { column: entry.offer.column }),
            mode: 'file',
        }));
    }, [props.id]);

    // Divider: the drag runs entirely on the UI runtime against absolute
    // pane widths, so no React state moves per frame. Geometry always uses
    // the available pane width (container minus divider): clamping against
    // the full width would let the divider push Surface under 360dp. Only
    // the release commits: it persists the per-device ratio and haptics,
    // and only when the value changed. `scheduleOnRN` (not deprecated
    // `runOnJS`) carries the release over.
    const effectiveRatio = clampSurfaceRatio(storedRatio ?? defaultSurfaceRatio(width), width, DIVIDER_ZONE);
    const ratioShared = useSharedValue(effectiveRatio);
    const widthShared = useSharedValue(width);
    const startRatio = useSharedValue(effectiveRatio);
    const draggedThisSession = React.useRef(false);
    const lastCommitted = React.useRef(effectiveRatio);
    // Late-arriving persisted ratio (storage hydrates after mount) applies
    // until the user drags. Effects, never render, may write shared values.
    React.useEffect(() => {
        if (draggedThisSession.current || storedRatio === null || storedRatio === undefined) return;
        const next = clampSurfaceRatio(storedRatio, widthShared.value, DIVIDER_ZONE);
        lastCommitted.current = next;
        ratioShared.value = next;
    }, [storedRatio, ratioShared, widthShared]);
    const commitRatio = React.useCallback((value: number, containerWidth: number) => {
        const next = clampSurfaceRatio(value, containerWidth, DIVIDER_ZONE);
        if (next === lastCommitted.current) return;
        lastCommitted.current = next;
        draggedThisSession.current = true;
        ratioShared.value = next;
        setStoredRatio(next);
        hapticsSelection();
    }, [setStoredRatio, ratioShared]);
    const stepDivider = React.useCallback((direction: 1 | -1) => {
        commitRatio(ratioShared.value + direction * DIVIDER_STEP, width);
    }, [commitRatio, ratioShared, width]);
    // A width change re-clamps the live split against the new divider-aware
    // geometry so neither pane drops under 360dp; the persisted preference
    // is left alone and re-clamps on load. No surface mounted means the
    // Agent already takes 100%: there is nothing to split.
    const lastWidth = React.useRef(width);
    React.useEffect(() => {
        if (lastWidth.current === width) return;
        lastWidth.current = width;
        widthShared.value = width;
        const next = clampSurfaceRatio(ratioShared.value, width, DIVIDER_ZONE);
        lastCommitted.current = next;
        ratioShared.value = next;
    }, [width, ratioShared, widthShared]);
    const pan = Gesture.Pan()
        .onStart(() => {
            startRatio.value = ratioShared.value;
        })
        .onUpdate((event) => {
            const available = widthShared.value - SURFACE_DIVIDER_ZONE_DP;
            const low = 360 / available;
            const high = 1 - 360 / available;
            if (!(low < high) || available <= 0) return;
            const next = startRatio.value + event.translationX / available;
            ratioShared.value = Math.min(high, Math.max(low, next));
        })
        .onEnd(() => {
            scheduleOnRN(commitRatio, ratioShared.value, widthShared.value);
        });
    // The split is a shared value too: on web an animated inline width set
    // by the worklet outlives the style prop, so leaving wide mode must
    // write the full width back rather than merely stop passing the style.
    const splitShared = useSharedValue(false);
    const agentWidthStyle = useAnimatedStyle(() => ({
        width: splitShared.value ? ratioShared.value * (widthShared.value - SURFACE_DIVIDER_ZONE_DP) : '100%',
    }));
    const surfaceWidthStyle = useAnimatedStyle(() => ({
        width: splitShared.value
            ? (widthShared.value - SURFACE_DIVIDER_ZONE_DP) - ratioShared.value * (widthShared.value - SURFACE_DIVIDER_ZONE_DP)
            : '100%',
    }));

    const returnToAgent = React.useCallback(() => setFocus('agent'), []);
    // Tools rows and pane actions ask for a surface by name; the shown name
    // goes back out so those lists can mark it.
    const focusRequest = useSurfaceFocusRequest(props.id);
    React.useEffect(() => {
        if (focusRequest === null) return;
        const entry = findSurfaceEntry(machineId, props.id, focusRequest.name);
        if (entry === undefined) return;
        if (entry.offer.kind === 'code-review') openCodeEntry(entry);
        else focusSurfaceName(focusRequest.name);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusRequest?.seq]);

    const openBlank = React.useCallback(() => {
        Keyboard.dismiss();
        setSelection(null);
        setTransientDirectUrl(null);
        setBlankOpen(true);
        setFocus('surface');
    }, []);
    const closeBlank = React.useCallback(() => {
        setBlankOpen(false);
        setFocus('agent');
    }, []);
    const openTransientDirect = React.useCallback((url: string) => {
        Keyboard.dismiss();
        setTransientDirectUrl(url);
        setFocus('surface');
    }, []);
    const closeTransientDirect = React.useCallback(() => {
        setTransientDirectUrl(null);
        setFocus('agent');
    }, []);

    const renderOfferPane = (entry: SurfaceEntry, approval: Approval | undefined): React.JSX.Element => {
        if (approval === undefined || approval.state === 'pending') {
            return (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}>
                    <Text style={{ color: theme.colors.textSecondary }}>Waiting for the plugin catalog…</Text>
                </View>
            );
        }
        if (approval.state === 'unavailable') {
            // Never mount a WebView the provider cannot hold.
            return (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: theme.colors.surface }}>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>
                        {approval.reason}
                    </Text>
                    <Pressable
                        onPress={returnToAgent}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Return to agent"
                        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }}
                    >
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Return to agent</Text>
                    </Pressable>
                </View>
            );
        }
        if (entry.offer.kind === 'browser-local') {
            return (
                <LocalBrowserSurface
                    entry={entry}
                    approved
                    blockedReason={null}
                    machineLabel={machineLabel}
                    registerBackHandler={registerSurfaceBack}
                    onOpenDirectUrl={openTransientDirect}
                    onUserClose={() => closeOffer(entry)}
                    onReturnToAgent={returnToAgent}
                />
            );
        }
        if (entry.offer.kind === 'browser-direct') {
            return (
                <DirectBrowserSurface
                    uri={entry.offer.url}
                    handle={entry.handle}
                    registerBackHandler={registerSurfaceBack}
                    onClose={() => closeOffer(entry)}
                    onReturnToAgent={returnToAgent}
                />
            );
        }
        if (entry.offer.kind === 'browser-session') {
            // Agent browser: the second named destination beside Preview.
            return (
                <HostBrowserView
                    offer={entry.offer}
                    machineId={machineId}
                    registerBackHandler={registerSurfaceBack}
                    onClose={() => closeOffer(entry)}
                    onReturnToAgent={returnToAgent}
                />
            );
        }
        return <View style={{ flex: 1, backgroundColor: theme.colors.surface }} />;
    };

    // One surface slot with a stable key per logical surface. The child key
    // stays on the name across revisions so newer records feed the mounted
    // surface instead of remounting it.
    let surfaceId: string | null = null;
    let surfaceNode: React.JSX.Element | null = null;
    if (transientDirectUrl !== null) {
        surfaceId = 'transient-direct';
        surfaceNode = (
            <DirectBrowserSurface
                key="transient-direct"
                uri={transientDirectUrl}
                registerBackHandler={registerSurfaceBack}
                onClose={closeTransientDirect}
                onReturnToAgent={returnToAgent}
            />
        );
    } else if (blankOpen) {
        surfaceId = 'blank';
        surfaceNode = (
            <DirectBrowserSurface
                key="blank"
                uri="about:blank"
                registerBackHandler={registerSurfaceBack}
                onClose={closeBlank}
                onReturnToAgent={returnToAgent}
            />
        );
    } else if (selectedEntry !== undefined) {
        surfaceId = `offer:${selectedEntry.offer.name}`;
        surfaceNode = (
            <View key={`offer:${selectedEntry.offer.name}`} style={{ flex: 1 }}>
                {renderOfferPane(selectedEntry, selectedApproval)}
            </View>
        );
    }
    // Open surfaces live in the session's pane actions (no permanent chrome),
    // the blank browser last. Unavailable offers say why instead of opening.
    const surfaceActions = React.useMemo<SurfaceAction[]>(() => [
        ...entries.flatMap((entry) => {
            const approval = approvals.get(entry.handle);
            if (approval === undefined || approval.state === 'pending') return [];
            const label = surfaceLabel(entry.offer);
            return [{
                key: entry.handle,
                icon: surfaceIcon(entry.offer),
                label,
                shown: selection === entry.offer.name,
                ...(approval.state === 'unavailable' ? { disabledReason: approval.reason } : {}),
                onPress: () => { if (entry.offer.kind === 'code-review') openCodeEntry(entry); else focusSurfaceName(entry.offer.name); },
            }];
        }),
        { key: 'blank', icon: 'globe-outline', label: 'Open blank browser', shown: blankOpen, onPress: openBlank },
    ], [entries, approvals, selection, blankOpen, openCodeEntry, focusSurfaceName, openBlank]);
    React.useEffect(() => {
        reportShownSurface(props.id, focus === 'surface' || wide ? selection : null);
    }, [props.id, focus, wide, selection]);

    const plan = planSurfacePanes({ wide, focus, surfaceId });
    const split = wide && surfaceId !== null;
    React.useEffect(() => {
        splitShared.value = split;
    }, [split, splitShared]);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.terminal.background }}>
            <View
                style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}
                onLayout={({ nativeEvent }) => {
                    // Every measured container change recomputes
                    // divider-aware clamps and shared geometry, so both
                    // mounted panes stay >=360dp after rotations, folds,
                    // and window resizes -- not just window-dimension
                    // changes. Always attached: a handler bound only while
                    // wide misses the very resize that makes it wide.
                    const containerWidth = nativeEvent.layout.width;
                    if (!(containerWidth > 0)) return;
                    setMeasuredWidth(containerWidth);
                    widthShared.value = containerWidth;
                    const next = clampSurfaceRatio(ratioShared.value, containerWidth, DIVIDER_ZONE);
                    lastCommitted.current = next;
                    ratioShared.value = next;
                }}
            >
                <Animated.View
                    key="agent-terminal"
                    // No Surface mounted means the Agent takes 100%: split
                    // sizing applies only beside a mounted surface.
                    style={split ? agentWidthStyle : plan.terminal.hidden ? hiddenPaneStyle : [{ flex: 1 }, agentWidthStyle]}
                    pointerEvents={plan.terminal.hidden ? 'none' : 'auto'}
                    accessibilityElementsHidden={plan.terminal.hidden}
                    importantForAccessibility={plan.terminal.hidden ? 'no-hide-descendants' : 'auto'}
                >
                    <TerminalRoute id={props.id} surfaceActions={surfaceActions} />
                </Animated.View>
                {wide && plan.surface !== null && (
                    <GestureDetector gesture={pan}>
                        <View
                            accessible
                            accessibilityRole="adjustable"
                            accessibilityLabel="Resize agent and browser panes"
                            accessibilityActions={[{ name: 'increment', label: 'Widen agent pane' }, { name: 'decrement', label: 'Narrow agent pane' }]}
                            onAccessibilityAction={({ nativeEvent }) => {
                                if (nativeEvent.actionName === 'increment') stepDivider(1);
                                else if (nativeEvent.actionName === 'decrement') stepDivider(-1);
                            }}
                            style={{ width: DIVIDER_ZONE, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <View style={{ width: 2, alignSelf: 'stretch', backgroundColor: theme.colors.divider }} />
                        </View>
                    </GestureDetector>
                )}
                {plan.surface !== null && (
                    <Animated.View
                        key={plan.surface.key}
                        // The surface pane sits at the window top (compact
                        // focus and wide alike), where the terminal owns its
                        // own inset but nothing else does: cutout and status
                        // bar must clear the chrome row.
                        style={split
                            ? [surfaceWidthStyle, { paddingTop: insets.top }]
                            : plan.surface.hidden
                                ? [hiddenPaneStyle, { paddingTop: insets.top }]
                                : [{ flex: 1, paddingTop: insets.top }, surfaceWidthStyle]}
                        pointerEvents={plan.surface.hidden ? 'none' : 'auto'}
                        accessibilityElementsHidden={plan.surface.hidden}
                        importantForAccessibility={plan.surface.hidden ? 'no-hide-descendants' : 'auto'}
                    >
                        {surfaceNode}
                    </Animated.View>
                )}
            </View>
        </View>
    );
}
