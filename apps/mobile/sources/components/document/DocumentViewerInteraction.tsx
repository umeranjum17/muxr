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
    onNavigateFile?: (path: string) => void;
    documentLabel?: string;
    accessibilityActions?: Array<{ name: string; label: string }>;
    onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
}) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const compact = useWindowDimensions().width < 340;
    const forward = I18nManager.isRTL ? -1 : 1;
    const prevIcon = forward === 1 ? 'chevron-back' : 'chevron-forward';
    const nextIcon = forward === 1 ? 'chevron-forward' : 'chevron-back';
    const navigation = props.navigation;
    const showHunks = props.mode === 'diff' && props.hunkCount > 1;

    return (
        <View style={[styles.bar, { paddingBottom: insets.bottom, backgroundColor: theme.colors.surface, borderTopColor: theme.colors.divider }]}>
            <View
                accessible
                accessibilityRole="summary"
                accessibilityLabel={props.documentLabel ?? t('files.file')}
                accessibilityActions={props.accessibilityActions}
                onAccessibilityAction={props.onAccessibilityAction}
                style={styles.documentActions}
            />
            <View style={styles.slot}>
                {navigation !== undefined && (
                    <View style={styles.fileControls}>
                        <NavPressable
                            disabled={navigation.previous === undefined}
                            onPress={() => { if (navigation.previous) props.onNavigateFile?.(navigation.previous.path); }}
                            accessibilityRole="button"
                            accessibilityLabel={navigation.previous?.title === undefined
                                ? t('files.previousFile')
                                : t('files.previousFileNamed', { title: navigation.previous.title, ordinal: navigation.index, total: navigation.total })}
                            accessibilityState={{ disabled: navigation.previous === undefined }}
                            style={() => styles.fileButton}
                        >
                            <Ionicons name={prevIcon} size={18} color={navigation.previous === undefined ? theme.colors.textSecondary : theme.colors.text} />
                        </NavPressable>
                        <Text
                            accessibilityRole="text"
                            accessibilityLabel={t('files.filePosition', { current: navigation.index + 1, total: navigation.total })}
                            style={[styles.filePosition, { fontSize: compact ? 10.5 : 11.5, color: theme.colors.textSecondary }]}
                        >
                            {navigation.index + 1}/{navigation.total}
                        </Text>
                        <NavPressable
                            disabled={navigation.next === undefined}
                            onPress={() => { if (navigation.next) props.onNavigateFile?.(navigation.next.path); }}
                            accessibilityRole="button"
                            accessibilityLabel={navigation.next?.title === undefined
                                ? t('files.nextFile')
                                : t('files.nextFileNamed', { title: navigation.next.title, ordinal: navigation.index + 2, total: navigation.total })}
                            accessibilityState={{ disabled: navigation.next === undefined }}
                            style={() => styles.fileButton}
                        >
                            <Ionicons name={nextIcon} size={18} color={navigation.next === undefined ? theme.colors.textSecondary : theme.colors.text} />
                        </NavPressable>
                    </View>
                )}
            </View>
            <View accessibilityRole="tablist" style={[styles.modeGroup, { borderColor: theme.colors.divider, backgroundColor: theme.colors.groupped.background }]}>
                {(['diff', 'file'] as const).map((mode) => {
                    const active = props.mode === mode;
                    const disabled = mode === 'diff' && !props.hasDiff;
                    const label = mode === 'diff'
                        ? (disabled ? t('files.diffUnavailable') : t('files.diff'))
                        : t('files.file');
                    return (
                        <NavPressable
                            key={mode}
                            disabled={disabled}
                            onPress={() => props.onModeChange(mode)}
                            accessibilityRole="tab"
                            accessibilityLabel={label}
                            accessibilityState={{ selected: active, disabled }}
                            hitSlop={{ vertical: 4 }}
                            style={(down) => [styles.mode, {
                                backgroundColor: active ? theme.colors.surfaceSelected : down ? theme.colors.surfacePressed : 'transparent',
                                opacity: disabled ? 0.45 : 1,
                            }]}
                        >
                            <Text style={{ color: active ? theme.colors.text : theme.colors.textSecondary, fontSize: 13, ...Typography.default(active ? 'semiBold' : undefined) }}>
                                {mode === 'diff' ? t('files.diff') : t('files.file')}
                            </Text>
                        </NavPressable>
                    );
                })}
            </View>
            <View style={[styles.slot, styles.slotEnd]}>
                {showHunks && (
                    <View style={styles.hunkControls}>
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
                                    hitSlop={{ horizontal: 3 }}
                                    style={() => [styles.hunkButton, { width: compact ? 34 : 38 }]}
                                >
                                    <Ionicons name={icon} size={18} color={disabled ? theme.colors.textSecondary : theme.colors.text} />
                                </NavPressable>
                            );
                        })}
                    </View>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    documentActions: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
    bar: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    slot: {
        minWidth: 132,
        flexDirection: 'row',
        alignItems: 'center',
    },
    slotEnd: {
        justifyContent: 'flex-end',
    },
    modeGroup: {
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        borderRadius: 9,
        borderWidth: StyleSheet.hairlineWidth,
    },
    mode: {
        width: 54,
        height: 36,
        borderRadius: 7,
        justifyContent: 'center',
        alignItems: 'center',
    },
    hunkControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    hunkButton: {
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    fileControls: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    fileButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    filePosition: {
        minWidth: 44,
        textAlign: 'center',
        ...Typography.mono('semiBold'),
    },
});
