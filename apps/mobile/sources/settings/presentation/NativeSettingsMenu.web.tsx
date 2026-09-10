import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import type { NativeSettingsMenuGroup, NativeSettingsMenuProps } from './NativeSettingsMenu.types';

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

type FlatOption = {
    group: NativeSettingsMenuGroup;
    key: string;
    label: string;
    selected: boolean;
};

/**
 * Accessible dropdown behind the same contract as the native menus: the
 * trigger is `children`, groups render labeled sections (or one flat list),
 * the selected option carries a checkmark, Escape and outside presses close,
 * and focus returns to the trigger on close.
 *
 * Keyboard model: opening moves focus to the selected option (or the first),
 * ArrowUp/ArrowDown/Home/End move within the menu, Enter/Space select,
 * Escape closes. Everything inside the menu is explicit so screen-reader and
 * keyboard behavior match instead of depending on pressable internals.
 */
export function NativeSettingsMenu({ groups, children, style, flat = false, disabled = false }: NativeSettingsMenuProps) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<React.ElementRef<typeof Pressable>>(null);
    const menuRef = React.useRef<View>(null);
    const optionRefs = React.useRef<Array<{ focus?: () => void } | null>>([]);
    const focusedIndexRef = React.useRef(0);

    // Stable flat order for focus movement; sections render from the same list.
    const flatOptions: FlatOption[] = React.useMemo(() => (
        groups.flatMap((group) => group.options.map((option) => ({
            group,
            key: option.key,
            label: option.label,
            selected: option.key === group.selectedKey,
        })))
    ), [groups]);

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

    const focusOption = React.useCallback((index: number) => {
        const count = flatOptions.length;
        if (count === 0) return;
        const clamped = ((index % count) + count) % count;
        focusedIndexRef.current = clamped;
        try {
            optionRefs.current[clamped]?.focus?.();
        } catch {
            // A missing node leaves focus where it is; arrows keep working.
        }
    }, [flatOptions.length]);

    const select = React.useCallback((option: FlatOption) => {
        close(true);
        option.group.onSelect(option.key);
    }, [close]);

    React.useEffect(() => {
        if (!open) return;
        // Initial focus: the selected option, else the first one. Poll
        // briefly instead of firing once: under load the options mount
        // after the menu container they live in.
        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            const mounted = optionRefs.current.some((node) => node !== null && node !== undefined);
            if (mounted || attempts >= 40) {
                clearInterval(timer);
                if (!mounted) return;
                const selected = flatOptions.findIndex((option) => option.selected);
                focusOption(selected === -1 ? 0 : selected);
            }
        }, 50);
        return () => clearInterval(timer);
    }, [open, focusOption, flatOptions]);

    React.useEffect(() => {
        if (!open || Platform.OS !== 'web') return;
        // Menu-level DOM handling: arrows/Home/End move, Enter/Space select
        // the focused option even where the pressable does not
        // keyboard-activate itself. Selecting twice is harmless.
        const menu = menuRef.current as unknown as {
            addEventListener?: (type: string, listener: (event: KeyboardEvent) => void) => void;
            removeEventListener?: (type: string, listener: (event: KeyboardEvent) => void) => void;
        } | null;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                focusOption(focusedIndexRef.current + 1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                focusOption(focusedIndexRef.current - 1);
            } else if (event.key === 'Home') {
                event.preventDefault();
                focusOption(0);
            } else if (event.key === 'End') {
                event.preventDefault();
                focusOption(flatOptions.length - 1);
            } else if (event.key === 'Enter' || event.key === ' ') {
                const option = flatOptions[focusedIndexRef.current];
                if (option !== undefined) {
                    event.preventDefault();
                    select(option);
                }
            }
        };
        menu?.addEventListener?.('keydown', onKeyDown);
        return () => {
            menu?.removeEventListener?.('keydown', onKeyDown);
        };
    }, [open, focusOption, flatOptions, select]);

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

    const onMenuKeyDown = (event: { key: string; preventDefault: () => void }) => {
        const active = Platform.OS === 'web' && typeof document !== 'undefined'
            ? document.activeElement as unknown as { getAttribute?: (name: string) => string | null } | null
            : null;
        const current = optionRefs.current.findIndex((node) => {
            try {
                return node !== null && (node as unknown as { isSameNode?: (other: unknown) => boolean })
                    .isSameNode?.(active) === true;
            } catch {
                return false;
            }
        });
        const at = current === -1 ? 0 : current;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusOption(at + 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusOption(at - 1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            focusOption(0);
        } else if (event.key === 'End') {
            event.preventDefault();
            focusOption(flatOptions.length - 1);
        } else if ((event.key === 'Enter' || event.key === ' ') && current !== -1) {
            // The focused option selects even where the pressable does not
            // keyboard-activate itself; selecting twice is harmless.
            event.preventDefault();
            const option = flatOptions[current];
            if (option !== undefined) select(option);
        }
    };

    const renderOption = (option: FlatOption, index: number) => (
        <Pressable
            key={`${option.group.key}:${option.key}`}
            ref={(node) => { optionRefs.current[index] = node; }}
            onPress={() => select(option)}
            style={styles.option}
            accessibilityRole="radio"
            accessibilityState={{ checked: option.selected }}
            accessibilityLabel={option.label}
        >
            <Text style={styles.optionLabel} numberOfLines={1}>{option.label}</Text>
            <View style={styles.check}>
                {option.selected ? <Ionicons name="checkmark" size={17} color={theme.colors.text} /> : null}
            </View>
        </Pressable>
    );

    let optionIndex = -1;
    const renderSections = () => {
        if (flat) {
            return flatOptions.map((option) => {
                optionIndex += 1;
                return renderOption(option, optionIndex);
            });
        }
        return groups.map((group) => (
            <View key={group.key}>
                <Text style={styles.groupLabel}>{group.label}</Text>
                {group.options.map((entry) => {
                    const option = flatOptions.find((candidate) => candidate.group === group && candidate.key === entry.key)
                        ?? { group, key: entry.key, label: entry.label, selected: false };
                    optionIndex += 1;
                    return renderOption(option, optionIndex);
                })}
            </View>
        ));
    };

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
                        ref={menuRef}
                        style={styles.menu}
                        accessibilityRole="menu"
                        accessibilityLabel="Composer options"
                    >
                        <ScrollView style={styles.menuScroll}>
                            {renderSections()}
                        </ScrollView>
                    </View>
                </>
            ) : null}
        </View>
    );
}
