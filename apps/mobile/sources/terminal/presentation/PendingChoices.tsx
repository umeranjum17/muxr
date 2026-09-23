import * as React from 'react';
import { Pressable, Text } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { sync } from '@/catalog/sync';
import { hapticsSelection } from '@/components/haptics';
import { withAlpha } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { pendingChoices, type PendingChoice } from '../domain/promptAvailability';

/** A question can arrive a beat after the status flips, and the next one can
 *  follow the last without the status ever leaving blocked. */
const READ_MS = 1_500;
/** The screen can still show an answered question until the agent redraws. */
const ANSWER_SETTLE_MS = 4_000;
const signature = (choices: readonly PendingChoice[]): string =>
    choices.map((choice) => `${choice.key}\u0000${choice.label}`).join('\n');

/**
 * The answers to the question a waiting agent is asking, as buttons along the
 * bottom of its terminal: the question stays readable above, and each answer
 * is one tap instead of a key hunted for in a scrolled row. A tap types the
 * answer's number through the same channel the key row writes to, which both
 * selects and confirms it. The screen is read with the passive `pane.read`,
 * so reading it never moves the agent's viewport.
 */
export const PendingChoices = React.memo(function PendingChoices({ sessionId, waiting, channel, onVisibilityChange }: {
    sessionId: string;
    /** The pane is blocked and this device may answer it. */
    waiting: boolean;
    channel?: { sendText: (text: string) => void };
    onVisibilityChange: (visible: boolean) => void;
}) {
    const { theme } = useUnistyles();
    const [choices, setChoices] = React.useState<PendingChoice[]>([]);
    const answered = React.useRef<{ signature: string; at: number } | null>(null);

    React.useEffect(() => {
        if (!waiting) {
            answered.current = null;
            setChoices([]);
            return;
        }
        let alive = true;
        let timer: ReturnType<typeof setTimeout>;
        const read = async (): Promise<void> => {
            try {
                const { text } = await sync.request('pane.read', { sessionId, source: 'visible' });
                if (!alive) return;
                const next = pendingChoices(text);
                const nextSignature = signature(next);
                const last = answered.current;
                if (last !== null && last.signature === nextSignature && Date.now() - last.at < ANSWER_SETTLE_MS) return;
                setChoices((current) => (signature(current) === nextSignature ? current : next));
            } catch {
                if (alive) setChoices([]);
            } finally {
                if (alive) timer = setTimeout(() => { void read(); }, READ_MS);
            }
        };
        void read();
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [sessionId, waiting]);

    const visible = waiting && choices.length > 0 && channel !== undefined;
    React.useLayoutEffect(() => { onVisibilityChange(visible); }, [onVisibilityChange, visible]);
    React.useEffect(() => () => onVisibilityChange(false), [onVisibilityChange]);

    if (!visible) return null;

    const answer = (choice: PendingChoice): void => {
        answered.current = { signature: signature(choices), at: Date.now() };
        setChoices([]);
        hapticsSelection();
        channel.sendText(choice.key);
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
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 6,
                paddingHorizontal: 8,
                paddingVertical: 8,
                backgroundColor: withAlpha(theme.colors.terminalChrome.canvas, 0.94),
            }}
        >
            {choices.map((choice) => (
                <Pressable
                    key={choice.key}
                    onPress={() => answer(choice)}
                    onLongPress={() => Modal.alert(`Answer ${choice.key}`, choice.label)}
                    accessibilityRole="button"
                    accessibilityLabel={`Answer ${choice.label}`}
                    accessibilityHint={`Types ${choice.key}`}
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
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 11, ...Typography.mono() }}>{choice.key}</Text>
                    <Text numberOfLines={2} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13 }}>{choice.label}</Text>
                </Pressable>
            ))}
        </Animated.View>
    );
});
