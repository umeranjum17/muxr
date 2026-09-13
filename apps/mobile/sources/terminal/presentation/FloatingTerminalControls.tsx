import * as React from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { PanelGlyphName } from '@/components/ActionShortcut';

export type TerminalCommand = {
    label: string;
    icon: PanelGlyphName;
    run: () => void;
    disabled?: boolean;
    dismiss?: boolean;
};
export type ToolsSide = 'left' | 'right';

export const FOOTER_ROW_HEIGHT = 52;
/** The footer's own edge: keys start here, the panel's card ends here. */
export const FOOTER_EDGE = 8;
const KEY_HEIGHT = 44;
const ROW = 44;
const PANEL_PADDING = 4;
// A sideways pull past this flips the dock; anything shorter is a tap.
const FLIP_DISTANCE = 40;

/** The word a quick key shows for a terminal command; the label stays its accessible name. */
const QUICK_KEY_WORD: Partial<Record<PanelGlyphName, string>> = { keyboard: 'Keyboard', minus: '−', plus: '+', reset: 'Reset' };

/**
 * One key in the panel's quick row: the same cap as ctrl/shift/esc beneath
 * it, a word or a symbol on it, never a drawing, so the row of quick keys
 * and the row of accessory keys read as one family.
 */
function Keycap({ word, label, onPress, disabled = false }: { word: string; label: string; onPress: () => void; disabled?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => ({
                minWidth: 44, height: KEY_HEIGHT, paddingHorizontal: 10, borderRadius: 6,
                alignItems: 'center', justifyContent: 'center',
                // One step up from the card, as the keys are from the footer.
                backgroundColor: theme.colors.surfaceHighest,
                opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
            })}
        >
            {/* Set like ctrl/shift beside it: the default face, one weight. */}
            <Text style={{ fontSize: word.length > 1 ? 14 : 16, lineHeight: 20, color: theme.colors.text }}>{word}</Text>
        </Pressable>
    );
}

/** The floating trigger's size and its distance from the terminal's edge. */
export const TOOLS_TRIGGER_SIZE = 36;
export const TOOLS_TRIGGER_MARGIN = 8;

/**
 * The trigger: one small floating icon over the terminal, in the thumb
 * zone -- the corner just above the footer, on the side the holding hand
 * prefers. It carries an identity (options: the controls for this
 * terminal), not a dot triple, and it is a mark, not a disc: 36dp at the
 * edge, translucent, and it dims while the output is being read back so
 * it never hides a line that matters. Dragging it sideways moves it to the
 * other edge; the same move is offered as an accessibility action. While
 * its panel is open it stays put and lit, and a second tap closes it.
 */
export function TerminalToolsTrigger({ side, onSideChange, onPress, blocked, expanded, dimmed }: {
    side: ToolsSide;
    onSideChange: (side: ToolsSide) => void;
    onPress: () => void;
    /** The keyboard would not go down: say so instead of opening nothing. */
    blocked: boolean;
    expanded: boolean;
    /** The output is being read back or streamed: step out of the way. */
    dimmed: boolean;
}) {
    const { theme } = useUnistyles();
    const sideRef = React.useRef(side);
    sideRef.current = side;
    const changeRef = React.useRef(onSideChange);
    changeRef.current = onSideChange;
    const drag = React.useRef(PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) => gesture.numberActiveTouches === 1 && Math.abs(gesture.dx) >= 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderRelease: (_event, gesture) => {
            if (gesture.dx <= -FLIP_DISTANCE && sideRef.current !== 'left') changeRef.current('left');
            else if (gesture.dx >= FLIP_DISTANCE && sideRef.current !== 'right') changeRef.current('right');
        },
        onPanResponderTerminationRequest: () => false,
    })).current;
    const other: ToolsSide = side === 'left' ? 'right' : 'left';
    return (
        <View {...drag.panHandlers} collapsable={false}
            style={{ position: 'absolute', bottom: TOOLS_TRIGGER_MARGIN, [side]: TOOLS_TRIGGER_MARGIN }}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={blocked ? 'Hide keyboard to open Tools' : expanded ? 'Close Tools' : 'Tools'}
                accessibilityHint={`Drag sideways to move to the ${other}.`}
                accessibilityState={{ expanded }}
                accessibilityActions={[{ name: 'move', label: `Move Tools to the ${other}` }]}
                onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'move') onSideChange(other); }}
                onPress={onPress}
                hitSlop={6}
                style={({ pressed }) => ({
                    width: TOOLS_TRIGGER_SIZE, height: TOOLS_TRIGGER_SIZE, borderRadius: 10,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: expanded ? theme.colors.accent : theme.colors.surfaceHigh,
                    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
                    opacity: pressed ? 0.7 : expanded ? 1 : dimmed ? 0.35 : 0.88,
                })}
            >
                <Ionicons name="options-outline" size={20} color={expanded ? theme.colors.button.primary.tint : theme.colors.text} />
            </Pressable>
        </View>
    );
}

/**
 * The open Tools panel: one card anchored directly above the key row that
 * opened it, at every width, in flow -- never over terminal rows, never a
 * corner card in a gutter. Its edges are the footer's edges. Inside, one
 * register: a row of quick keys across the top (the terminal's own
 * keyboard and zoom, then Close), set exactly like the accessory keys
 * beneath the panel; a hairline; then the labelled rows with their data
 * inline, one line each. It takes at most half the screen so the terminal
 * keeps at least the rows it had while typing; a longer list scrolls and
 * rows never shrink. The Tools key, a tap on the terminal, Back and Escape
 * close it too.
 */
export function TerminalToolsPanel({ commands, bottomInset, onClose, children }: {
    commands: readonly TerminalCommand[];
    bottomInset: number;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const maxHeight = Math.max(ROW * 3, Math.floor(height / 2) - bottomInset - FOOTER_EDGE);
    return (
        // The card sits the footer's edge in on three sides; the keys below
        // already carry their own top margin, so the bottom gap matches.
        <View style={{ paddingHorizontal: FOOTER_EDGE, paddingTop: FOOTER_EDGE, paddingBottom: FOOTER_EDGE - PANEL_PADDING }}>
            <View accessibilityRole="menu" accessibilityLabel="Tools"
                style={{ maxHeight, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingVertical: PANEL_PADDING }}>
                    {commands.map((command) => (
                        <Keycap key={command.icon} word={QUICK_KEY_WORD[command.icon] ?? command.label} label={command.label} disabled={command.disabled === true}
                            onPress={() => { if (command.dismiss) onClose(); command.run(); }} />
                    ))}
                    <View style={{ flex: 1 }} />
                    <Keycap word="Close" label="Close Tools" onPress={onClose} />
                </View>
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }} />
                <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingVertical: PANEL_PADDING }} keyboardShouldPersistTaps="always" nestedScrollEnabled>
                    {children}
                </ScrollView>
            </View>
        </View>
    );
}
