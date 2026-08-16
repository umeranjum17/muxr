import * as React from 'react';
import { Platform, Pressable, View, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { hapticsLight } from '@/components/haptics';

interface StatusCardProps {
    /** Left glyph box (18px). */
    icon: React.ReactNode;
    title: string;
    titleColor?: string;
    /** Right of the title, before the chevron (counts, badges). */
    headerRight?: React.ReactNode;
    expanded: boolean;
    onToggle: () => void;
    /** Smaller, quieter header — for background-noise cards like thinking. */
    compact?: boolean;
    /** One faded italic line under the header while collapsed. */
    preview?: string | null;
    /** Expanded body; rendered under a hairline divider. */
    children?: React.ReactNode;
    /** Tints the border (goal needs attention). */
    accentBorderColor?: string;
    accessibilityLabel?: string;
    /**
     * Sits directly on the composer (Codex-style): transparent with no border,
     * so it blends whether the composer is a solid panel or the native glass
     * one, and a negative margin that eats the composer's top padding.
     */
    attached?: boolean;
    /** Outer margins etc. — the shell owns only its own chrome. */
    style?: ViewStyle;
}

/**
 * The one collapsible status card: thinking, todos and goal all render in
 * this shell so the chat and the composer stack speak a single language —
 * surfaceHigh fill, hairline border, quiet header, chevron, hairline body.
 */
export const StatusCard = React.memo(function StatusCard(props: StatusCardProps) {
    const { theme } = useUnistyles();
    const handlePress = React.useCallback(() => {
        if (Platform.OS !== 'web') hapticsLight();
        props.onToggle();
    }, [props.onToggle]);

    return (
        <View
            style={[
                styles.card,
                {
                    backgroundColor: props.attached || props.compact === true ? 'transparent' : theme.colors.surfaceHigh,
                    borderColor: props.accentBorderColor ?? theme.colors.divider,
                },
                props.attached && styles.cardAttached,                props.style,
            ]}
        >
            <Pressable
                onPress={handlePress}
                accessibilityRole="button"
                accessibilityState={{ expanded: props.expanded }}
                accessibilityLabel={props.accessibilityLabel ?? props.title}
                hitSlop={{ top: 8, bottom: 8 }}
                style={({ pressed }) => [styles.header, props.compact === true && styles.headerCompact, pressed && styles.headerPressed]}
            >
                <View style={[styles.iconBox, props.compact === true && styles.iconBoxCompact]}>{props.icon}</View>
                <Text
                    style={[styles.title, props.compact === true && styles.titleCompact, { color: props.titleColor ?? theme.colors.text }]}
                    numberOfLines={1}
                >
                    {props.title}
                </Text>
                {props.headerRight}
                <Ionicons
                    name={props.expanded ? 'chevron-down' : 'chevron-forward'}
                    size={13}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
            {!props.expanded && props.preview != null && props.preview !== '' && (
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={[styles.preview, { color: theme.colors.textSecondary }]}
                >
                    {props.preview}
                </Text>
            )}
            {props.expanded && props.children != null && (
                <View style={[styles.body, { borderTopColor: theme.colors.divider }]}>
                    {props.children}
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
    cardAttached: {
        borderRadius: 0,
        borderWidth: 0,
        // Cancels AgentInput's container paddingTop. Intentionally does NOT
        // touch the fill or corners: anything the card draws of its own is a
        // seam the moment the composer switches fills (native glass).
        marginBottom: -8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 8,
    },
    headerCompact: {
        paddingVertical: 6,
        gap: 7,
    },
    headerPressed: {
        opacity: 0.65,
    },
    iconBox: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    title: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    titleCompact: {
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default(),
    },
    iconBoxCompact: {
        width: 16,
        height: 16,
    },
    preview: {
        marginTop: -4,
        paddingBottom: 10,
        // Aligns under the title: header padding + icon box + gap.
        paddingLeft: 12 + 18 + 8,
        paddingRight: 12,
        fontSize: 13,
        lineHeight: 17,
        fontStyle: 'italic',
        opacity: 0.55,
    },
    body: {
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
}));
