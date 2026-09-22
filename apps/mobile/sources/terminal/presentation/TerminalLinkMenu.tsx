import * as React from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { displayLink } from '../domain/TerminalLink';

/** One thing you can do with the link that was pressed. */
export type LinkAction = {
    id: string;
    label: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    /** Shown under the label when the action needs a boundary stated. */
    note?: string;
    run: () => void;
};

const CARD_MAX = 260;
const GAP = 12;
const linkCardHeight = (actionCount: number): number => 60 + actionCount * 46;
export const terminalLinkCardFits = (height: number | undefined, actionCount: number): boolean =>
    height !== undefined && height >= linkCardHeight(actionCount) + 16;

/**
 * What you can do with one link the terminal printed, offered WHERE THE LINK
 * IS rather than at the bottom of the screen. The gesture happened on the
 * terminal, so the answer belongs on the terminal — the same principle as the
 * ring opening around its own trigger rather than at a fixed screen edge.
 *
 * The card names the link first, so there is never a doubt which one is about
 * to be acted on, and it is clamped inside the terminal so a link pressed at
 * an edge still gets a whole card.
 */
export function TerminalLinkMenu({ url, at, region, actions, onClose }: {
    url: string;
    /** Where the press landed, in the terminal's own coordinates. */
    at: { x: number; y: number };
    region: { width: number; height: number };
    actions: readonly LinkAction[];
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    React.useEffect(() => {
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
        return () => subscription.remove();
    }, [onClose]);

    const width = Math.min(CARD_MAX, Math.max(160, region.width - 24));
    const height = linkCardHeight(actions.length);
    const left = Math.max(8, Math.min(at.x - width / 2, Math.max(8, region.width - width - 8)));
    // Below the finger, or above it when there is no room below, so the card
    // never sits under the thumb that opened it.
    const below = at.y + GAP;
    const top = below + height <= region.height - 8 ? below : Math.max(8, at.y - GAP - height);
    return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <Pressable accessibilityLabel="Close link actions" accessible={false} onPress={onClose} style={StyleSheet.absoluteFill} />
            <Animated.View
                entering={FadeIn.duration(120).reduceMotion(ReduceMotion.System)}
                exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
                accessibilityViewIsModal
                style={{
                    position: 'absolute', left, top, width, height,
                    borderRadius: 14, overflow: 'hidden',
                    backgroundColor: theme.colors.terminalChrome.floating,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: theme.colors.glass.border,
                }}
            >
                <ScrollView style={{ flex: 1 }} bounces={false} showsVerticalScrollIndicator={false}>
                    <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.glass.divider }}>
                        <Text numberOfLines={2} style={{ color: theme.colors.textSecondary, fontSize: 11, lineHeight: 15 }}>{displayLink(url, 88)}</Text>
                    </View>
                    {actions.map((action) => (
                        <Pressable
                            key={action.id}
                            accessibilityRole="menuitem"
                            accessibilityLabel={action.note === undefined ? action.label : `${action.label}. ${action.note}`}
                            onPress={() => { onClose(); action.run(); }}
                            style={({ pressed }) => ({
                                minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 10,
                                paddingHorizontal: 12, paddingVertical: 6,
                                backgroundColor: pressed ? theme.colors.surfaceHighest : 'transparent',
                            })}
                        >
                            <Ionicons name={action.icon} size={17} color={theme.colors.textSecondary} />
                            <View style={{ flex: 1 }}>
                                <Text style={{ color: theme.colors.text, fontSize: 14 }}>{action.label}</Text>
                                {action.note !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 1 }}>{action.note}</Text>}
                            </View>
                        </Pressable>
                    ))}
                </ScrollView>
            </Animated.View>
        </View>
    );
}
