import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { SessionInfo } from '@muxr/contract';

import { t } from '@/text';

/**
 * Presence of an agent's browser or emulator in the terminal header: a mark
 * and a live dot while the host can show one, and a one-time tooltip when it
 * first appears. Nothing is reserved while there is none, and the chip is
 * shorter than the header row, so the terminal below never re-attaches.
 */

type PreviewPresence = NonNullable<SessionInfo['preview']>;

const TOOLTIP_WIDTH = 252;
const TOOLTIP_MS = 6_000;
const LABEL_WIDTH = 72;
const EASE_OUT = Easing.out(Easing.cubic);

/** A window already introduced in this run of the app is never introduced again. */
const introduced = new Set<string>();

/** Whether the tooltip for this pane's current browser or emulator is up. */
export function usePreviewTooltip(sessionId: string, preview: PreviewPresence | undefined): { open: boolean; dismiss: () => void } {
    const key = preview === undefined ? undefined : `${sessionId}\n${preview.since}`;
    const [open, setOpen] = React.useState<string>();
    React.useEffect(() => {
        if (key === undefined || introduced.has(key)) return;
        introduced.add(key);
        setOpen(key);
    }, [key]);
    React.useEffect(() => {
        if (open === undefined) return;
        const timer = setTimeout(() => setOpen(undefined), TOOLTIP_MS);
        return () => clearTimeout(timer);
    }, [open]);
    const dismiss = React.useCallback(() => setOpen(undefined), []);
    return { open: open !== undefined && open === key, dismiss };
}

/**
 * Keeps the last value on screen while it fades out. Layout animations are
 * not used: on web they pin the view absolute at its first size, so the chip
 * could neither grow its label nor hold its place in the header row.
 */
function usePresence<T>(value: T | undefined, enterMs: number, exitMs: number): { held: T | undefined; progress: SharedValue<number> } {
    const reduceMotion = useReducedMotion();
    const [held, setHeld] = React.useState(value);
    const progress = useSharedValue(0);
    React.useEffect(() => {
        if (value !== undefined) {
            setHeld(value);
            progress.value = withTiming(1, { duration: reduceMotion ? 120 : enterMs, easing: EASE_OUT });
            return;
        }
        const duration = reduceMotion ? 120 : exitMs;
        progress.value = withTiming(0, { duration });
        const timer = setTimeout(() => setHeld(undefined), duration);
        return () => clearTimeout(timer);
    }, [value, reduceMotion, enterMs, exitMs, progress]);
    return { held: value ?? held, progress };
}

function kindCopy(kind: PreviewPresence['kind']) {
    return kind === 'android'
        ? { icon: 'logo-android' as const, chip: t('preview.chipAndroid'), intro: t('preview.introAndroid') }
        : { icon: 'globe-outline' as const, chip: t('preview.chipBrowser'), intro: t('preview.introBrowser') };
}

export const PreviewChip = React.memo((props: {
    /** Absent once the window is gone; the chip then fades out. */
    preview: PreviewPresence | undefined;
    /** Tooltip up: the chip names its kind beside the mark. */
    labelled: boolean;
    onPress: () => void;
    onLayout: (box: { x: number; width: number }) => void;
}) => {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const { held, progress } = usePresence(props.preview, 160, 140);
    const labelled = useSharedValue(props.labelled ? 1 : 0);
    React.useEffect(() => {
        labelled.value = withTiming(props.labelled ? 1 : 0, { duration: reduceMotion ? 120 : 160, easing: EASE_OUT });
    }, [props.labelled, reduceMotion, labelled]);
    const chip = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ scale: reduceMotion ? 1 : 0.92 + 0.08 * progress.value }],
    }), [reduceMotion]);
    // Reduced motion keeps the fade but not the width change.
    const label = useAnimatedStyle(() => ({
        maxWidth: (reduceMotion ? Math.round(labelled.value) : labelled.value) * LABEL_WIDTH,
        opacity: labelled.value,
    }), [reduceMotion]);
    if (held === undefined) return null;
    const copy = kindCopy(held.kind);
    return (
        <Animated.View style={chip} onLayout={(event) => props.onLayout({ x: event.nativeEvent.layout.x, width: event.nativeEvent.layout.width })}>
            <Pressable
                onPress={props.onPress}
                disabled={props.preview === undefined}
                accessibilityRole="button"
                accessibilityLabel={t('preview.chipAccessibility', { kind: held.kind, title: held.title })}
                hitSlop={{ top: 4, bottom: 4 }}
                style={({ pressed }) => ({
                    height: 24,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingLeft: 7,
                    paddingRight: 8,
                    marginHorizontal: 2,
                    borderRadius: 999,
                    backgroundColor: theme.colors.terminalChrome[pressed ? 'clusterPressed' : 'cluster'],
                })}
            >
                <Ionicons name={copy.icon} size={13} color={theme.colors.text} />
                <Animated.View style={[{ overflow: 'hidden' }, label]}>
                    <Text numberOfLines={1} style={{ marginLeft: 5, color: theme.colors.text, fontSize: 11, fontWeight: '600' }}>{copy.chip}</Text>
                </Animated.View>
                {/* Steady, never pulsing: presence, not an alarm. */}
                <View style={{ marginLeft: 5, width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.status.connected }} />
            </Pressable>
        </Animated.View>
    );
});

/**
 * Hangs under the chip over the top of the terminal. Only the card takes
 * touches; the terminal around it stays fully usable.
 */
export const PreviewTooltip = React.memo((props: {
    /** Absent once the tooltip should go; it then fades out. */
    preview: PreviewPresence | undefined;
    /** The chip's horizontal centre and the header's bottom, in the screen's coordinates. */
    anchor: { centre: number; top: number };
    screenWidth: number;
    onWatch: () => void;
    onDismiss: () => void;
}) => {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const { held, progress } = usePresence(props.preview, 180, 160);
    const card = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: reduceMotion ? 0 : 4 * (1 - progress.value) }],
    }), [reduceMotion]);
    if (held === undefined) return null;
    const copy = kindCopy(held.kind);
    const left = Math.max(8, Math.min(props.anchor.centre - TOOLTIP_WIDTH / 2, props.screenWidth - TOOLTIP_WIDTH - 8));
    return (
        <Animated.View
            pointerEvents={props.preview === undefined ? 'none' : 'auto'}
            accessibilityLiveRegion="polite"
            aria-live="polite"
            style={[{
                position: 'absolute',
                zIndex: 15,
                top: props.anchor.top + 6,
                left,
                width: TOOLTIP_WIDTH,
                paddingHorizontal: 12,
                paddingTop: 12,
                paddingBottom: 10,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHighest,
                shadowColor: '#000',
                shadowOpacity: 0.55,
                shadowRadius: 15,
                shadowOffset: { width: 0, height: 10 },
                elevation: 12,
            }, card]}
        >
            <View style={{
                position: 'absolute',
                top: -6,
                left: props.anchor.centre - left - 5,
                width: 10,
                height: 10,
                borderLeftWidth: 1,
                borderTopWidth: 1,
                borderColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHighest,
                transform: [{ rotate: '45deg' }],
            }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name={copy.icon} size={14} color={theme.colors.text} />
                <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>{copy.intro}</Text>
            </View>
            {held.title !== undefined && held.title !== ''
                && <Text numberOfLines={1} style={{ marginTop: 3, color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16 }}>{held.title}</Text>}
            <View style={{ marginTop: 10, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <Pressable onPress={props.onDismiss} accessibilityRole="button" accessibilityLabel={t('preview.notNow')}
                    style={({ pressed }) => ({ height: 30, paddingHorizontal: 10, borderRadius: 999, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>{t('preview.notNow')}</Text>
                </Pressable>
                <Pressable onPress={props.onWatch} accessibilityRole="button" accessibilityLabel={t('preview.watch')}
                    style={({ pressed }) => ({ height: 30, paddingHorizontal: 14, borderRadius: 999, justifyContent: 'center', backgroundColor: theme.colors.text, opacity: pressed ? 0.8 : 1 })}>
                    <Text style={{ color: theme.colors.surface, fontSize: 12, fontWeight: '600' }}>{t('preview.watch')}</Text>
                </Pressable>
            </View>
        </Animated.View>
    );
});
