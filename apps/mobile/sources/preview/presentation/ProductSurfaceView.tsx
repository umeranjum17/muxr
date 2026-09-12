import * as React from 'react';
import { ActivityIndicator, AppState, Modal as RNModal, Platform, Pressable, Share, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { pluginSnapshot } from '@/plugins';
import { openExternalUrl } from '@/utils/openExternalUrl';
import type { SurfaceEntry } from '@/catalog/application/surfaceCoordinator';
import { onSurfaceReload } from '@/catalog/application/surfaceCoordinator';
import {
    attachPreviewTunnel,
    releaseSurfaceLease,
    requestProductSurfaceLease,
    startSurfaceRenewLoop,
    type PreviewTunnel,
    type SurfaceRenewLoop,
} from '../application/OpenPreview';
import { SURFACE_FRAME_HAS_HISTORY, SurfaceFrame, isDirectUrl, type SurfaceFrameHandle } from './SurfaceFrame';

/** The exact provider must be approved and still claim the exact capability. */
export function surfaceProviderApproved(provider: string, capability: string): boolean {
    return pluginSnapshot().some((entry) => entry.summary.pluginId === provider && entry.summary.capabilities[capability] !== undefined);
}

/** Register (or clear) this surface's history-back handler with the sole back owner. */
export type SurfaceBackRegistration = (handler: (() => boolean) | null) => void;

function ChromeButton(props: { label: string; icon: string; disabled?: boolean; onPress: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            disabled={props.disabled === true}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: props.disabled === true ? 0.35 : pressed ? 0.6 : 1,
            })}
        >
            <Ionicons name={props.icon as never} size={22} color={theme.colors.text} />
        </Pressable>
    );
}

interface OverflowItem {
    label: string;
    icon: string;
    destructive?: boolean;
    onPress: () => void;
}

/** Compact overflow menu in a real Modal: always on screen, 44dp rows, dismissible outside. */
function OverflowMenu(props: { label: string; items: OverflowItem[] }): React.JSX.Element {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [anchorTop, setAnchorTop] = React.useState(64);
    const buttonRef = React.useRef<View>(null);
    const openMenu = React.useCallback(() => {
        const node = buttonRef.current as unknown as {
            measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
        } | null;
        if (node?.measureInWindow !== undefined) {
            node.measureInWindow((_x, y, _width, height) => setAnchorTop(y + height + 4));
        }
        setOpen(true);
    }, []);
    return (
        <View ref={buttonRef} collapsable={false}>
            <Pressable
                onPress={openMenu}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={props.label}
                accessibilityState={{ expanded: open }}
                style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: pressed ? 0.6 : 1,
                    backgroundColor: open ? theme.colors.surfaceHigh : 'transparent',
                })}
            >
                <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.text} />
            </Pressable>
            <RNModal transparent visible={open} animationType="none" onRequestClose={() => setOpen(false)}>
                <Pressable onPress={() => setOpen(false)} accessibilityLabel="Close menu" accessibilityRole="button" style={{ flex: 1 }}>
                    <View style={{
                        position: 'absolute',
                        right: 8,
                        top: anchorTop,
                        minWidth: 220,
                        borderRadius: 14,
                        overflow: 'hidden',
                        backgroundColor: theme.colors.surfaceHigh,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        elevation: 12,
                    }}>
                        {props.items.map((item) => (
                            <Pressable
                                key={item.label}
                                onPress={() => { setOpen(false); item.onPress(); }}
                                accessibilityRole="button"
                                accessibilityLabel={item.label}
                                style={({ pressed }) => ({
                                    minHeight: 44,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: 10,
                                    paddingHorizontal: 14,
                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                })}
                            >
                                <Ionicons name={item.icon as never} size={18} color={item.destructive === true ? theme.colors.status.error : theme.colors.textSecondary} />
                                <Text style={{ ...Typography.default(), flex: 1, color: item.destructive === true ? theme.colors.status.error : theme.colors.text }}>
                                    {item.label}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </RNModal>
        </View>
    );
}

function Banner(props: { label: string; onPress: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, backgroundColor: theme.colors.surfaceHigh }}
        >
            <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>{props.label}</Text>
        </Pressable>
    );
}

function Notice(props: { text: string; destructive?: boolean }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <Text style={{ ...Typography.default(), color: props.destructive === true ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 16, paddingBottom: 4 }} numberOfLines={2}>
            {props.text}
        </Text>
    );
}

function Centered(props: { children: React.ReactNode }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: theme.colors.surface }}>
            {props.children}
        </View>
    );
}

function TextAction(props: { label: string; onPress: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    return (
        <Pressable onPress={props.onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={props.label} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }}>
            <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>{props.label}</Text>
        </Pressable>
    );
}

function foreignDomain(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return 'that link';
    }
}

const openInTabLabel = Platform.OS === 'web' ? 'Open in a browser tab' : 'Open in system browser';

/**
 * The mounted local surface: an expiring host lease for one offer generation,
 * the encrypted tunnel that lease opened, and the renewal that keeps it.
 * Everything async is fenced by `generation`, captured before the first
 * await and compared after every one: a close, an update, a revoke or an
 * unmount that lands mid-attach closes what arrived instead of adopting it.
 */
type LocalPhase =
    | { state: 'attaching' }
    | { state: 'ready'; url: string; origin: string }
    | { state: 'lost'; reason: string }
    | { state: 'parked' };

/**
 * Local Browser companion for one current offer.
 *
 * Lease, attach, mount; on teardown unmount, close the tunnel, release the
 * lease. Provider loss, renewal refusal, a relay close, native background,
 * unmount and explicit close all reach the same detach. A newer offer
 * generation follows before the user interacts; afterwards it waits behind
 * an explicit Show. Reload is the update mechanism.
 */
export function LocalBrowserSurface(props: {
    entry: SurfaceEntry;
    approved: boolean;
    blockedReason: string | null;
    machineLabel?: string | undefined;
    registerBackHandler: SurfaceBackRegistration;
    onOpenDirectUrl: (url: string) => void;
    onUserClose: () => void;
    onReturnToAgent: () => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const frameRef = React.useRef<SurfaceFrameHandle | null>(null);
    const offer = props.entry.offer;
    const offerPath = offer.kind === 'browser-local' ? offer.path : '/';
    const [phase, setPhase] = React.useState<LocalPhase>({ state: 'attaching' });
    const [loading, setLoading] = React.useState(false);
    const [nav, setNav] = React.useState({ canGoBack: false, canGoForward: false });
    const [blocked, setBlocked] = React.useState<string | null>(null);
    const [pendingHandle, setPendingHandle] = React.useState<string | null>(null);
    const [pendingReload, setPendingReload] = React.useState<{ handle: string; command: number } | null>(null);
    const interactedRef = React.useRef(false);
    const generationRef = React.useRef(0);
    const mountedHandleRef = React.useRef<string | null>(null);
    const ownerRef = React.useRef<{ tunnel: PreviewTunnel; lease: string; renew: SurfaceRenewLoop } | null>(null);

    /** One ending for everything: stop renewing, drop the page, close, release. */
    const detach = React.useCallback((next: LocalPhase) => {
        generationRef.current += 1;
        const owner = ownerRef.current;
        ownerRef.current = null;
        mountedHandleRef.current = null;
        setPhase(next);
        if (owner === null) return;
        owner.renew.stop();
        try { owner.tunnel.close(); } catch { /* already closed */ }
        void releaseSurfaceLease(owner.lease);
    }, []);

    const attach = React.useCallback(async (handle: string) => {
        detach({ state: 'attaching' });
        const generation = generationRef.current;
        const current = (): boolean => generation === generationRef.current;
        interactedRef.current = false;
        setBlocked(null);
        setPendingHandle(null);
        setPendingReload(null);
        let lease: { lease: string } | undefined;
        try {
            lease = await requestProductSurfaceLease(handle);
            if (!current()) {
                void releaseSurfaceLease(lease.lease);
                return;
            }
            const leaseId = lease.lease;
            const tunnel = await attachPreviewTunnel({ lease: leaseId }, {
                onClosed: () => {
                    if (!current()) return;
                    detach({ state: 'lost', reason: 'The connection to this page closed.' });
                },
            });
            if (!current()) {
                tunnel.close();
                void releaseSurfaceLease(leaseId);
                return;
            }
            const base = tunnel.url !== undefined ? tunnel.url.replace(/\/$/, '') : `http://${tunnel.hostname}:${tunnel.port}`;
            const renew = startSurfaceRenewLoop(leaseId, {
                onLost: (reason) => {
                    if (!current()) return;
                    detach({ state: 'lost', reason: `This page is no longer available. ${reason}` });
                },
            });
            ownerRef.current = { tunnel, lease: leaseId, renew };
            mountedHandleRef.current = handle;
            setPhase({ state: 'ready', url: `${base}${offerPath}`, origin: base });
        } catch (error) {
            if (!current()) return;
            if (lease !== undefined) void releaseSurfaceLease(lease.lease);
            detach({ state: 'lost', reason: error instanceof Error ? error.message : String(error) });
        }
    }, [detach, offerPath]);

    // Mount on first approval; unmount ends everything.
    const handle = props.entry.handle;
    React.useEffect(() => {
        if (!props.approved || props.blockedReason !== null) {
            detach({ state: 'parked' });
            return;
        }
        if (mountedHandleRef.current === handle) return;
        if (mountedHandleRef.current === null || !interactedRef.current) {
            void attach(handle);
            return;
        }
        // A newer generation after interaction waits behind Show. The host
        // may end the previous generation's lease meanwhile; that arrives
        // through onClosed and shows as lost with the same Show action.
        setPendingHandle(handle);
    }, [handle, props.approved, props.blockedReason, attach, detach]);
    React.useEffect(() => () => detach({ state: 'parked' }), [detach]);

    // Native background releases the loopback listener; foreground
    // reattaches to the offer path. Web keeps the frame: no listener exists.
    React.useEffect(() => {
        if (Platform.OS === 'web') return undefined;
        const subscription = AppState.addEventListener('change', (next) => {
            if (next === 'background') {
                if (ownerRef.current !== null) detach({ state: 'parked' });
            } else if (next === 'active' && ownerRef.current === null && props.approved && props.blockedReason === null) {
                void attach(handle);
            }
        });
        return () => subscription.remove();
    }, [attach, detach, handle, props.approved, props.blockedReason]);

    // Host reload orders for the mounted handle: immediately before
    // interaction, parked behind Show after it, applied exactly once.
    React.useEffect(() => onSurfaceReload((target, command) => {
        if (target !== mountedHandleRef.current) return;
        if (interactedRef.current) {
            setPendingReload({ handle: target, command });
            return;
        }
        frameRef.current?.reload();
    }), []);

    React.useEffect(() => {
        if (!SURFACE_FRAME_HAS_HISTORY || !nav.canGoBack) {
            props.registerBackHandler(null);
            return;
        }
        props.registerBackHandler(() => {
            frameRef.current?.goBack();
            return true;
        });
        return () => props.registerBackHandler(null);
    }, [nav.canGoBack, props.registerBackHandler]);

    const markInteracted = React.useCallback(() => {
        interactedRef.current = true;
    }, []);
    const close = React.useCallback(() => {
        detach({ state: 'parked' });
        props.onUserClose();
    }, [detach, props.onUserClose]);

    const title = offer.title;
    const chrome = (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, minHeight: 56 }}>
            {SURFACE_FRAME_HAS_HISTORY && <ChromeButton label="Back" icon="chevron-back" disabled={!nav.canGoBack} onPress={() => frameRef.current?.goBack()} />}
            {SURFACE_FRAME_HAS_HISTORY && <ChromeButton label="Forward" icon="chevron-forward" disabled={!nav.canGoForward} onPress={() => frameRef.current?.goForward()} />}
            {loading && SURFACE_FRAME_HAS_HISTORY
                ? <ChromeButton label="Stop" icon="close" onPress={() => frameRef.current?.stop()} />
                : <ChromeButton label="Reload" icon="refresh" onPress={() => { setBlocked(null); frameRef.current?.reload(); }} />}
            <View style={{ flex: 1, paddingHorizontal: 8 }}>
                <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text }} numberOfLines={1}>{title}</Text>
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                    {props.machineLabel === undefined ? 'Local app on your computer' : `Local app on ${props.machineLabel}`}
                </Text>
            </View>
            <ChromeButton label="Return to agent" icon="chatbubble-outline" onPress={props.onReturnToAgent} />
            <OverflowMenu label="Browser options" items={[{ label: 'Close browser', icon: 'close', destructive: true, onPress: close }]} />
        </View>
    );

    let body: React.JSX.Element;
    if (props.blockedReason !== null) {
        body = (
            <Centered>
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>{props.blockedReason}</Text>
                <TextAction label="Return to agent" onPress={props.onReturnToAgent} />
            </Centered>
        );
    } else if (phase.state === 'ready') {
        body = (
            <View style={{ flex: 1 }} onTouchStart={markInteracted}>
                <SurfaceFrame
                    ref={frameRef}
                    uri={phase.url}
                    mode={{ kind: 'local', origin: phase.origin }}
                    onBlockedUrl={(url) => setBlocked(url)}
                    onInteract={markInteracted}
                    onRendererGone={() => {
                        markInteracted();
                        detach({ state: 'lost', reason: 'The page stopped responding.' });
                    }}
                    onLoadStart={() => setLoading(true)}
                    onLoadEnd={() => setLoading(false)}
                    onNavigation={(state) => {
                        setNav({ canGoBack: state.canGoBack, canGoForward: state.canGoForward });
                        if (state.url !== phase.url) markInteracted();
                    }}
                    onError={(description) => {
                        setLoading(false);
                        setBlocked(null);
                        detach({ state: 'lost', reason: description });
                    }}
                />
            </View>
        );
    } else if (phase.state === 'lost') {
        body = (
            <Centered>
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>{phase.reason}</Text>
                <TextAction label="Reopen" onPress={() => void attach(pendingHandle ?? handle)} />
                <TextAction label="Return to agent" onPress={props.onReturnToAgent} />
            </Centered>
        );
    } else {
        body = (
            <Centered>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>Opening {title}…</Text>
            </Centered>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            {chrome}
            {pendingHandle !== null && pendingHandle !== mountedHandleRef.current && (
                <Banner label="Agent updated · Show" onPress={() => void attach(pendingHandle)} />
            )}
            {pendingReload !== null && pendingReload.handle === mountedHandleRef.current && (
                <Banner label="Agent reloaded · Show" onPress={() => { setPendingReload(null); interactedRef.current = false; frameRef.current?.reload(); }} />
            )}
            {blocked !== null && (
                <View style={{ paddingHorizontal: 16, paddingBottom: 6, gap: 4 }}>
                    <Notice text={`This page wants to leave the local app for ${foreignDomain(blocked)}.`} />
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                        {isDirectUrl(blocked) && <TextAction label="Open in Browser" onPress={() => { const url = blocked; setBlocked(null); props.onOpenDirectUrl(url); }} />}
                        <TextAction label={openInTabLabel} onPress={() => { const url = blocked; setBlocked(null); void openExternalUrl(url).catch(() => undefined); }} />
                        <TextAction label="Stay" onPress={() => setBlocked(null)} />
                    </View>
                </View>
            )}
            {body}
        </View>
    );
}

/**
 * Direct HTTPS or the honest blank tab, in the device's own browser session:
 * never an inherited host profile. On web a site may refuse to be framed,
 * so the labelled external action is always one tap away.
 */
export function DirectBrowserSurface(props: {
    uri: string;
    /** Offer handle when this view renders an offer; reload orders match on it. */
    handle?: string | undefined;
    registerBackHandler: SurfaceBackRegistration;
    onClose: () => void;
    onReturnToAgent: () => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const frameRef = React.useRef<SurfaceFrameHandle | null>(null);
    const [appliedUri, setAppliedUri] = React.useState(props.uri);
    const [draft, setDraft] = React.useState(props.uri);
    const [editing, setEditing] = React.useState(false);
    const [addressError, setAddressError] = React.useState(false);
    const [blocked, setBlocked] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [nav, setNav] = React.useState({ canGoBack: false, canGoForward: false });
    const [pendingUri, setPendingUri] = React.useState<string | null>(null);
    const [pendingReload, setPendingReload] = React.useState<{ handle: string; command: number } | null>(null);
    const interactedRef = React.useRef(false);
    const appliedRef = React.useRef(props.uri);
    appliedRef.current = appliedUri;
    const handleRef = React.useRef(props.handle);
    handleRef.current = props.handle;

    // An updated offer URL follows before interaction; afterwards it waits
    // behind an explicit Show instead of hijacking the page.
    const offeredUri = props.uri;
    React.useEffect(() => {
        if (offeredUri === appliedRef.current) {
            setPendingUri((current) => (current === offeredUri ? null : current));
            return;
        }
        if (!interactedRef.current) {
            setAppliedUri(offeredUri);
            setDraft(offeredUri);
            setPendingUri(null);
            return;
        }
        setPendingUri(offeredUri);
    }, [offeredUri]);

    React.useEffect(() => {
        if (!SURFACE_FRAME_HAS_HISTORY || !nav.canGoBack) {
            props.registerBackHandler(null);
            return;
        }
        props.registerBackHandler(() => {
            frameRef.current?.goBack();
            return true;
        });
        return () => props.registerBackHandler(null);
    }, [nav.canGoBack, props.registerBackHandler]);

    React.useEffect(() => onSurfaceReload((handle, command) => {
        if (handleRef.current === undefined || handle !== handleRef.current) return;
        if (interactedRef.current) {
            setPendingReload({ handle, command });
            return;
        }
        frameRef.current?.reload();
    }), []);
    React.useEffect(() => {
        setPendingReload(null);
    }, [props.handle]);

    const markInteracted = React.useCallback(() => {
        interactedRef.current = true;
    }, []);

    const submitAddress = React.useCallback(() => {
        setEditing(false);
        const clean = draft.trim();
        // Scheme-less input is an HTTPS address, never a search.
        const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) ? clean : `https://${clean}`;
        if (isDirectUrl(candidate)) {
            setAddressError(false);
            setBlocked(false);
            setError(null);
            interactedRef.current = true;
            setAppliedUri(candidate);
            setDraft(candidate);
            setPendingUri(null);
            return;
        }
        setAddressError(true);
        setDraft(appliedRef.current);
    }, [draft]);

    const shareable = appliedUri === 'about:blank' ? null : appliedUri;
    const openExternally = React.useCallback(() => {
        if (shareable === null) return;
        void openExternalUrl(shareable).catch(() => undefined);
    }, [shareable]);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, minHeight: 56 }}>
                {SURFACE_FRAME_HAS_HISTORY && <ChromeButton label="Back" icon="chevron-back" disabled={!nav.canGoBack} onPress={() => frameRef.current?.goBack()} />}
                {loading && SURFACE_FRAME_HAS_HISTORY
                    ? <ChromeButton label="Stop" icon="close" onPress={() => frameRef.current?.stop()} />
                    : <ChromeButton label="Reload" icon="refresh" onPress={() => frameRef.current?.reload()} />}
                <TextInput
                    value={draft}
                    onChangeText={(text) => { setDraft(text); setAddressError(false); }}
                    onFocus={() => setEditing(true)}
                    onBlur={submitAddress}
                    onSubmitEditing={submitAddress}
                    returnKeyType="go"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="Enter an HTTPS address"
                    placeholderTextColor={theme.colors.textSecondary}
                    accessibilityLabel="Web address. Enter an HTTPS address."
                    style={{
                        flex: 1,
                        minHeight: 44,
                        color: addressError ? theme.colors.textDestructive : theme.colors.text,
                        backgroundColor: theme.colors.surfaceHigh,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                    }}
                />
                {Platform.OS === 'web' && shareable !== null && <ChromeButton label={openInTabLabel} icon="open-outline" onPress={openExternally} />}
                <ChromeButton label="Return to agent" icon="chatbubble-outline" onPress={props.onReturnToAgent} />
                <OverflowMenu
                    label="Browser options"
                    items={[
                        ...(shareable === null ? [] : [
                            ...(Platform.OS === 'web' ? [] : [{ label: 'Share', icon: 'share-outline', onPress: () => { void Share.share({ message: shareable }).catch(() => undefined); } }]),
                            { label: openInTabLabel, icon: 'open-outline', onPress: openExternally },
                        ]),
                        { label: 'Close browser', icon: 'close', destructive: true, onPress: props.onClose },
                    ]}
                />
            </View>
            {addressError && <Notice text="Enter a credential-free HTTPS address or about:blank." destructive />}
            {blocked && <Notice text="This link cannot open here." />}
            {Platform.OS === 'web' && shareable !== null && !editing && (
                <Notice text={`External site. If it refuses to be embedded, use ${openInTabLabel}.`} />
            )}
            {pendingUri !== null && pendingUri !== appliedUri && (
                <Banner label="Agent updated · Show" onPress={() => { setAppliedUri(pendingUri); setDraft(pendingUri); setPendingUri(null); setBlocked(false); }} />
            )}
            {pendingReload !== null && (props.handle === undefined || pendingReload.handle === handleRef.current) && (
                <Banner label="Agent reloaded · Show" onPress={() => { setPendingReload(null); interactedRef.current = false; frameRef.current?.reload(); }} />
            )}
            {error !== null && <Notice text={error} />}
            <View style={{ flex: 1 }} onTouchStart={markInteracted}>
                <SurfaceFrame
                    ref={frameRef}
                    uri={appliedUri}
                    mode={{ kind: 'direct' }}
                    onBlockedUrl={() => setBlocked(true)}
                    onInteract={markInteracted}
                    onRendererGone={() => {
                        markInteracted();
                        setError('The page stopped responding. Reload to try again.');
                    }}
                    onLoadStart={() => { setLoading(true); setError(null); }}
                    onLoadEnd={() => setLoading(false)}
                    onNavigation={(state) => {
                        setNav({ canGoBack: state.canGoBack, canGoForward: state.canGoForward });
                        setBlocked(false);
                        if (state.url !== appliedRef.current) {
                            markInteracted();
                            if (!editing) setDraft(state.url);
                        }
                    }}
                    onError={() => {
                        setLoading(false);
                        setError('The page failed to load. Check the address and try again.');
                    }}
                />
            </View>
        </View>
    );
}
