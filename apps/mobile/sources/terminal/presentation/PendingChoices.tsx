import * as React from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { usePendingChoices } from '../application/usePendingChoices';
import { useTerminalColors } from './useTerminalColors';

/** The stack's own breathing room above and below the chips. */
const STACK_PAD = 8;

/**
 * The answers to the question a waiting agent is asking, as buttons along the
 * bottom of its terminal: the question stays readable above, and each answer
 * is one tap instead of a key hunted for in a scrolled row. A tap types the
 * answer's number, or the arrow presses and Enter that reach it, through the
 * same channel the key row writes to, which both selects and confirms it.
 * The screen is read with the passive `pane.read`, in colour so a button
 * selected only by its background shows, and reading it never moves the
 * agent's viewport.
 */
export const PendingChoices = React.memo(function PendingChoices({ sessionId, waiting, channel, onVisibilityChange, lineHeight, gridInset, columns }: {
    sessionId: string;
    /** The pane is blocked and this device may answer it. */
    waiting: boolean;
    channel?: { sendText: (text: string) => void };
    onVisibilityChange: (visible: boolean) => void;
    /** The terminal's row height, so the band behind the chips can end on a line boundary. */
    lineHeight?: number;
    /** The gap between the terminal's last row and the box the band sits in, so a
     *  short viewport that does not divide into whole rows still ends on a line. */
    gridInset?: number;
    /** The terminal grid width in columns the pane is drawn at; wrapped
     *  unnumbered labels are rejoined against it. */
    columns?: number;
}) {
    const { theme } = useUnistyles();
    const { colors: terminalColors } = useTerminalColors();
    const [stackHeight, setStackHeight] = React.useState(0);
    const { choices, answer } = usePendingChoices({ sessionId, waiting, ...(channel === undefined ? {} : { channel }), ...(columns === undefined ? {} : { columns }) });

    const visible = waiting && choices.length > 0 && channel !== undefined;
    React.useLayoutEffect(() => { onVisibilityChange(visible); }, [onVisibilityChange, visible]);
    React.useEffect(() => () => onVisibilityChange(false), [onVisibilityChange]);

    if (!visible) return null;

    // A solid band in the terminal's own resolved background (the colour the
    // person tunes in Settings), so it tracks the terminal and no text shows
    // between or behind the chips. Its top is padded so the band's edge lands
    // on a terminal row boundary (measured from the terminal's own grid, offset
    // by the gap between the last row and the band's own box): the line directly
    // above the chips keeps its full descenders instead of being half-covered.
    const bandInset = gridInset !== undefined && gridInset > 0 ? gridInset : 0;
    const padTop = lineHeight !== undefined && lineHeight > 0 && stackHeight > 0
        ? STACK_PAD + (((bandInset - (stackHeight + STACK_PAD * 2)) % lineHeight + lineHeight) % lineHeight)
        : STACK_PAD;
    const measureStack = (event: LayoutChangeEvent): void => {
        const next = event.nativeEvent.layout.height;
        setStackHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };

    return (
        <Animated.View
            entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
            style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                paddingHorizontal: STACK_PAD,
                paddingTop: padTop,
                paddingBottom: STACK_PAD,
                backgroundColor: terminalColors.background,
            }}
        >
            <View onLayout={measureStack} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {choices.map((choice) => (
                    <Pressable
                        key={choice.key}
                        onPress={() => answer(choice)}
                        onLongPress={() => Modal.alert(choice.number === undefined ? 'Answer' : `Answer ${choice.number}`, choice.label)}
                        accessibilityRole="button"
                        accessibilityLabel={`Answer ${choice.label}`}
                        {...(choice.number === undefined ? {} : { accessibilityHint: `Types ${choice.number}` })}
                        style={({ pressed }) => ({
                            maxWidth: '100%',
                            minHeight: 36,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                            paddingHorizontal: 12,
                            borderRadius: 999,
                            backgroundColor: pressed ? theme.colors.terminalChrome.clusterPressed : theme.colors.terminalChrome.cluster,
                        })}
                    >
                        {choice.number !== undefined && <Text style={{ color: theme.colors.textSecondary, fontSize: 11, ...Typography.mono() }}>{choice.number}</Text>}
                        <Text numberOfLines={2} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13 }}>{choice.label}</Text>
                    </Pressable>
                ))}
            </View>
        </Animated.View>
    );
});
