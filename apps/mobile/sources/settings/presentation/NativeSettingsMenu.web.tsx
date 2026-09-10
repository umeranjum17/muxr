import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu.types';

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    triggerDisabled: {
        opacity: 0.4,
    },
    menu: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 8,
        minWidth: 220,
        maxWidth: 300,
        maxHeight: 270,
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: theme.colors.glass.backgroundStrong,
        zIndex: 61,
    },
    menuScroll: {
        flexGrow: 0,
    },
    groupLabel: {
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 2,
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    option: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    optionLabel: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default(),
    },
    check: {
        width: 20,
        alignItems: 'center',
    },
}));

/**
 * Accessible dropdown behind the same contract as the native menus: the
 * trigger is `children`, groups render labeled sections (or one flat list),
 * the selected option carries a checkmark, Escape and outside presses close,
 * and focus returns to the trigger on close.
 */
export function NativeSettingsMenu({ groups, children, style, flat = false, disabled = false }: NativeSettingsMenuProps) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<React.ElementRef<typeof Pressable>>(null);

    const close = React.useCallback((restoreFocus: boolean) => {
        setOpen(false);
        if (restoreFocus && Platform.OS === 'web') {
            const node = triggerRef.current as unknown as { focus?: () => void } | null;
            requestAnimationFrame(() => {
                try {
                    node?.focus?.();
                } catch {
                    // Focus restore is best-effort; the menu already closed.
                }
            });
        }
    }, []);

    React.useEffect(() => {
        if (!open || Platform.OS !== 'web' || typeof document === 'undefined') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close(true);
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [open, close]);

    const select = React.useCallback((group: (typeof groups)[number], key: string) => {
        setOpen(false);
        group.onSelect(key);
    }, [groups]);

    const renderOptions = (options: { key: string; label: string }[], selectedKey: string | null | undefined, onSelect: (key: string) => void, prefix: string) => (
        options.map((option) => {
            const selected = option.key === selectedKey;
            return (
                <Pressable
                    key={`${prefix}:${option.key}`}
                    onPress={() => onSelect(option.key)}
                    style={styles.option}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={option.label}
                >
                    <Text style={styles.optionLabel} numberOfLines={1}>{option.label}</Text>
                    <View style={styles.check}>
                        {selected ? <Ionicons name="checkmark" size={17} color={theme.colors.text} /> : null}
                    </View>
                </Pressable>
            );
        })
    );

    return (
        <View style={[styles.container, style]}>
            <Pressable
                ref={triggerRef}
                onPress={() => {
                    if (!disabled) setOpen((value) => !value);
                }}
                accessibilityRole="button"
                accessibilityLabel="Composer options"
                accessibilityState={{ expanded: open, disabled }}
            >
                <View pointerEvents="none" style={disabled && styles.triggerDisabled}>
                    {children}
                </View>
            </Pressable>
            {open && !disabled ? (
                <>
                    <View
                        // Full-viewport scrim: fixed positioning is web-only,
                        // outside the shared style contract.
                        style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60 } as unknown as ViewStyle}
                        onStartShouldSetResponder={() => true}
                        onResponderRelease={() => close(false)}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    />
                    <View
                        style={styles.menu}
                        accessibilityRole="menu"
                        accessibilityLabel="Composer options"
                    >
                        <ScrollView style={styles.menuScroll}>
                            {flat ? groups.flatMap((group) => (
                                renderOptions(group.options, group.selectedKey, (key) => select(group, key), group.key)
                            )) : groups.map((group) => (
                                <View key={group.key}>
                                    <Text style={styles.groupLabel}>{group.label}</Text>
                                    {renderOptions(group.options, group.selectedKey, (key) => select(group, key), group.key)}
                                </View>
                            ))}
                        </ScrollView>
                    </View>
                </>
            ) : null}
        </View>
    );
}
