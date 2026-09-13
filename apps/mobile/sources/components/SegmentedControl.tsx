import * as React from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsLight } from '@/components/haptics';

export type SegmentedOption<K extends string = string> = { key: K; label: string; disabled?: boolean };

/**
 * One row of two to four mutually exclusive choices, all visible at once,
 * instead of a chevron into a sheet or a pile of switches. The chosen
 * segment is a neutral raised pill: the control never competes with the
 * form's one accent. Inside an ItemGroup the group's title is its label
 * and the group's footer explains the current choice.
 */
export function SegmentedControl<K extends string>({ options, value, onChange, accessibilityLabel, disabled = false, style }: {
    options: ReadonlyArray<SegmentedOption<K>>;
    value: K | undefined;
    onChange: (key: K) => void;
    accessibilityLabel: string;
    disabled?: boolean;
    /** Cloned in by ItemGroup onto every child; a control has no divider to show. */
    showDivider?: boolean;
    /** Inside a Field the field owns the margins. */
    style?: StyleProp<ViewStyle>;
}) {
    // Under 340 wide three single-word segments cannot hold 15px text and
    // 8px pads; tighter pills and a smaller label keep every word whole.
    const narrow = useUnistyles().rt.screen.width < 340;
    return (
        <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.track, narrow && styles.trackNarrow, disabled && styles.disabled, style]}>
            {options.map((option) => {
                const checked = option.key === value;
                const off = disabled || option.disabled === true;
                return (
                    <Pressable
                        key={option.key}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ checked, disabled: off }}
                        disabled={off}
                        onPress={() => { if (!checked) { hapticsLight(); onChange(option.key); } }}
                        style={({ pressed }) => [styles.segment, narrow && styles.segmentNarrow, checked && styles.segmentChecked, pressed && !checked && styles.segmentPressed, option.disabled && styles.disabled]}
                    >
                        <Text numberOfLines={1} style={[styles.label, narrow && styles.labelNarrow, checked && styles.labelChecked]}>{option.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    track: {
        flexDirection: 'row',
        marginHorizontal: 16,
        marginVertical: 12,
        padding: 2,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHighest,
    },
    segment: {
        flex: 1,
        minHeight: 36,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'transparent',
    },
    trackNarrow: {
        marginHorizontal: 8,
    },
    segmentNarrow: {
        paddingHorizontal: 3,
    },
    labelNarrow: {
        fontSize: 13,
        lineHeight: 18,
    },
    segmentChecked: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
    },
    segmentPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    label: {
        ...Typography.default('regular'),
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    labelChecked: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    disabled: {
        opacity: 0.4,
    },
}));
