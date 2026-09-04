import * as React from 'react';
import { I18nManager, Pressable, View, useWindowDimensions, type AccessibilityActionEvent } from 'react-native';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type DocumentDisplayMode = 'file' | 'diff';

export type DocumentViewerNavigation = {
    index: number;
    total: number;
    previous?: { path: string; title?: string };
    next?: { path: string; title?: string };
};

const RETENTION = { top: 8, bottom: 8, left: 8, right: 8 };

function NavPressable(props: {
    disabled?: boolean;
    onPress: () => void;
    accessibilityRole: 'button' | 'tab';
    accessibilityLabel: string;
    accessibilityState?: { disabled?: boolean; selected?: boolean };
    hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number; vertical?: number; horizontal?: number };
    style: (pressed: boolean) => object | object[];
    children: React.ReactNode;
}) {
    const [pressed, setPressed] = React.useState(false);
    return (
        <Pressable
            disabled={props.disabled}
            onPress={props.onPress}
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            accessibilityRole={props.accessibilityRole}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={props.accessibilityState}
            hitSlop={props.hitSlop}
            pressRetentionOffset={RETENTION}
            style={({ pressed: down }) => props.style(down)}
        >
            <Animated.View style={{ transform: [{ scale: pressed ? 0.96 : 1 }], transitionProperty: 'transform', transitionDuration: 120 }}>
                {props.children}
            </Animated.View>
        </Pressable>
    );
}

export function DocumentNavigatorBar(props: {
    mode: DocumentDisplayMode;
    hasDiff: boolean;
    hunkCount: number;
    hunkIndex: number;
    navigation?: DocumentViewerNavigation;
    onModeChange: (mode: DocumentDisplayMode) => void;
    onJumpHunk: (step: number) => void;
    wrap: boolean;
    onWrapChange: (wrap: boolean) => void;
    /** The shared ladder: same three actions the terminal pane exposes. */
    onZoom: (direction: 1 | -1) => void;
    onResetZoom: () => void;
    atMinZoom: boolean;
    atMaxZoom: boolean;
    zoomed: boolean;
    onNavigateFile?: (path: string) => void;
    documentLabel?: string;
    accessibilityActions?: Array<{ name: string; label: string }>;
    onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
}) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const width = useWindowDimensions().width;
    const compact = width < 340;
    const forward = I18nManager.isRTL ? -1 : 1;
    const prevIcon = forward === 1 ? 'chevron-back' : 'chevron-forward';
    const nextIcon = forward === 1 ? 'chevron-forward' : 'chevron-back';
    const navigation = props.navigation;
    const showHunks = props.mode === 'diff' && props.hunkCount > 1;
    // Both modes pan now, so both can be put back into wrapping.
    const showWrap = true;
    // Every control here is a fixed 44 dp and cannot shrink, so the row has a
    // hard minimum: 7 buttons + 18 padding = 326 dp, against a 288 dp lane on
    // a 320 dp screen. `flexShrink` cannot remove a fixed width - the groups
    // would simply overlap - so controls have to leave the row instead.
    //
    // Below 480 dp with both nav groups the two "3/12" counters go first,
    // 406 -> 326, which clears the 379 and 361 dp lanes. On the existing
    // compact branch the zoom pair follows them into the menu: 5 buttons +
    // padding = 238 dp, inside 288. Nothing loses its 44 dp target, and
    // every count stays on its button's accessibility label.
    const showCounts = !(showHunks && navigation !== undefined) || width >= 480;
    const showZoomChips = !compact;

    const [menu, setMenu] = React.useState(false);

    return (
        <>
            {menu && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                    onPress={() => setMenu(false)}
                    style={StyleSheet.absoluteFill}
                />
            )}
            {menu && (
                <View style={[styles.menu, {
                    bottom: 52 + insets.bottom + 20,
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                }]}>
                    {(['diff', 'file'] as const).map((mode) => {
                        const disabled = mode === 'diff' && !props.hasDiff;
                        return (
                            <NavPressable
                                key={mode}
                                disabled={disabled}
                                onPress={() => { props.onModeChange(mode); setMenu(false); }}
                                accessibilityRole="tab"
                                accessibilityLabel={mode === 'diff' ? t('files.diff') : t('files.file')}
                                accessibilityState={{ selected: props.mode === mode, disabled }}
                                style={(down) => [styles.menuRow, { backgroundColor: down ? theme.colors.surfacePressed : 'transparent', opacity: disabled ? 0.45 : 1 }]}
                            >
                                <Ionicons
                                    name={props.mode === mode ? 'checkmark' : 'remove'}
                                    size={16}
                                    color={props.mode === mode ? theme.colors.text : 'transparent'}
                                />
                                <Text style={{ color: theme.colors.text, fontSize: 14, ...Typography.default() }}>
                                    {mode === 'diff' ? t('files.diff') : t('files.file')}
                                </Text>
                            </NavPressable>
                        );
                    })}
                    {showWrap && (
                        <NavPressable
                            onPress={() => { props.onWrapChange(!props.wrap); setMenu(false); }}
                            accessibilityRole="button"
                            accessibilityLabel={t('files.wrapLines')}
                            accessibilityState={{ selected: props.wrap }}
                            style={(down) => [styles.menuRow, { backgroundColor: down ? theme.colors.surfacePressed : 'transparent' }]}
                        >
                            <Ionicons name={props.wrap ? 'checkmark' : 'remove'} size={16} color={props.wrap ? theme.colors.text : 'transparent'} />
                            <Text style={{ color: theme.colors.text, fontSize: 14, ...Typography.default() }}>{t('files.wrapLines')}</Text>
                        </NavPressable>
                    )}
                    {/* The chips left the row to fit a 320 dp screen, so the
                        ladder has to be reachable here or it is gone. */}
                    {!showZoomChips && ([['remove', -1], ['add', 1]] as const).map(([glyph, direction]) => {
                        const disabled = direction < 0 ? props.atMinZoom : props.atMaxZoom;
                        return (
                            <NavPressable
                                key={glyph}
                                disabled={disabled}
                                onPress={() => props.onZoom(direction)}
                                accessibilityRole="button"
                                accessibilityLabel={direction < 0 ? t('files.zoomOut') : t('files.zoomIn')}
                                accessibilityState={{ disabled }}
                                style={(down) => [styles.menuRow, { backgroundColor: down ? theme.colors.surfacePressed : 'transparent' }]}
                            >
                                <Ionicons name={glyph} size={16} color={disabled ? theme.colors.textSecondary : theme.colors.text} />
                                <Text style={{ color: disabled ? theme.colors.textSecondary : theme.colors.text, fontSize: 14, ...Typography.default() }}>
                                    {direction < 0 ? t('files.zoomOut') : t('files.zoomIn')}
                                </Text>
                            </NavPressable>
                        );
                    })}
                    {props.zoomed && (
                        <NavPressable
                            onPress={() => { props.onResetZoom(); setMenu(false); }}
                            accessibilityRole="button"
                            accessibilityLabel={t('files.resetZoom')}
                            style={(down) => [styles.menuRow, { backgroundColor: down ? theme.colors.surfacePressed : 'transparent' }]}
                        >
                            <Ionicons name="refresh" size={16} color={theme.colors.text} />
                            <Text style={{ color: theme.colors.text, fontSize: 14, ...Typography.default() }}>{t('files.resetZoom')}</Text>
                        </NavPressable>
                    )}
                </View>
            )}
            <View style={[styles.lane, { bottom: 12 + insets.bottom }]} pointerEvents="box-none">
            <View style={[styles.bar, {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.divider,
            }]}>
                <View
                    accessible
                    accessibilityRole="summary"
                    accessibilityLabel={props.documentLabel ?? t('files.file')}
                    accessibilityActions={props.accessibilityActions}
                    onAccessibilityAction={props.onAccessibilityAction}
                    style={styles.documentActions}
                />
                {navigation !== undefined && (
                    <View style={styles.group}>
                        <NavPressable
                            disabled={navigation.previous === undefined}
                            onPress={() => { if (navigation.previous) props.onNavigateFile?.(navigation.previous.path); }}
                            accessibilityRole="button"
                            accessibilityLabel={navigation.previous?.title === undefined
                                ? t('files.previousFile')
                                : t('files.previousFileNamed', { title: navigation.previous.title, ordinal: navigation.index, total: navigation.total })}
                            accessibilityState={{ disabled: navigation.previous === undefined }}
                            style={() => styles.round}
                        >
                            <Ionicons name={prevIcon} size={18} color={navigation.previous === undefined ? theme.colors.textSecondary : theme.colors.text} />
                        </NavPressable>
                        {showCounts && (
                            <Text
                                accessibilityRole="text"
                                accessibilityLabel={t('files.filePosition', { current: navigation.index + 1, total: navigation.total })}
                                style={[styles.position, { fontSize: compact ? 10.5 : 11.5, color: theme.colors.textSecondary }]}
                            >
                                {navigation.index + 1}/{navigation.total}
                            </Text>
                        )}
                        <NavPressable
                            disabled={navigation.next === undefined}
                            onPress={() => { if (navigation.next) props.onNavigateFile?.(navigation.next.path); }}
                            accessibilityRole="button"
                            accessibilityLabel={navigation.next?.title === undefined
                                ? t('files.nextFile')
                                : t('files.nextFileNamed', { title: navigation.next.title, ordinal: navigation.index + 2, total: navigation.total })}
                            accessibilityState={{ disabled: navigation.next === undefined }}
                            style={() => styles.round}
                        >
                            <Ionicons name={nextIcon} size={18} color={navigation.next === undefined ? theme.colors.textSecondary : theme.colors.text} />
                        </NavPressable>
                    </View>
                )}
                {showHunks && (
                    <View style={styles.group}>
                        {([['chevron-up', -1], ['chevron-down', 1]] as const).map(([icon, step]) => {
                            const atStart = step < 0 && props.hunkIndex <= 0;
                            const atEnd = step > 0 && props.hunkIndex >= props.hunkCount - 1;
                            const disabled = atStart || atEnd;
                            return (
                                <NavPressable
                                    key={icon}
                                    disabled={disabled}
                                    onPress={() => props.onJumpHunk(step)}
                                    accessibilityRole="button"
                                    accessibilityLabel={step < 0
                                        ? t('files.previousChangeAt', { current: Math.max(1, props.hunkIndex), total: props.hunkCount })
                                        : t('files.nextChangeAt', { current: Math.min(props.hunkCount, props.hunkIndex + 2), total: props.hunkCount })}
                                    accessibilityState={{ disabled }}
                                    style={() => styles.round}
                                >
                                    <Ionicons name={icon} size={18} color={disabled ? theme.colors.textSecondary : theme.colors.text} />
                                </NavPressable>
                            );
                        })}
                        {showCounts && (
                            <Text style={[styles.position, { fontSize: compact ? 10.5 : 11.5, color: theme.colors.textSecondary }]}>
                                {Math.min(props.hunkCount, props.hunkIndex + 1)}/{props.hunkCount}
                            </Text>
                        )}
                    </View>
                )}
                {showZoomChips && (
                <View style={styles.group}>
                    {([['remove', -1], ['add', 1]] as const).map(([glyph, direction]) => {
                        const disabled = direction < 0 ? props.atMinZoom : props.atMaxZoom;
                        return (
                            <NavPressable
                                key={glyph}
                                disabled={disabled}
                                onPress={() => props.onZoom(direction)}
                                accessibilityRole="button"
                                accessibilityLabel={direction < 0 ? t('files.zoomOut') : t('files.zoomIn')}
                                accessibilityState={{ disabled }}
                                style={() => styles.round}
                            >
                                <Ionicons name={glyph} size={18} color={disabled ? theme.colors.textSecondary : theme.colors.text} />
                            </NavPressable>
                        );
                    })}
                </View>
                )}
                <NavPressable
                    onPress={() => setMenu((open) => !open)}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.toggleFileAndDiff')}
                    accessibilityState={{ selected: menu }}
                    style={(down) => [styles.round, { backgroundColor: down || menu ? theme.colors.surfacePressed : 'transparent' }]}
                >
                    <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.text} />
                </NavPressable>
            </View>
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    documentActions: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
    // Floats clear of the code rather than sitting on a band across it, so a
    // line is never sliced by an opaque strip with no scrim behind it. The
    // lane is full width; the pill inside it is only as wide as its controls.
    lane: {
        position: 'absolute',
        left: 16,
        right: 16,
        alignItems: 'center',
    },
    bar: {
        height: 52,
        borderRadius: 26,
        maxWidth: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 6,
        gap: 2,
        borderWidth: StyleSheet.hairlineWidth,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.16,
        shadowRadius: 16,
        elevation: 6,
    },
    menu: {
        position: 'absolute',
        right: 16,
        minWidth: 180,
        borderRadius: 14,
        paddingVertical: 6,
        borderWidth: StyleSheet.hairlineWidth,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.16,
        shadowRadius: 16,
        elevation: 8,
    },
    menuRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        height: 44,
        paddingHorizontal: 14,
    },
    group: {
        flexDirection: 'row',
        alignItems: 'center',
        // Belt as well as braces: if a future control pushes the row past
        // the lane again, the groups give way instead of pushing the
        // overflow button off the screen edge.
        flexShrink: 1,
        minWidth: 0,
    },
    round: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    position: {
        minWidth: 40,
        textAlign: 'center',
        ...Typography.mono('semiBold'),
    },
});
