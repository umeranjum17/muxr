import * as React from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { PanelGlyphName } from '@/components/ActionShortcut';
import { PANE_GESTURE_IGNORE_ID } from '../application/usePaneGestures';

export type TerminalCommand = {
    label: string;
    icon: PanelGlyphName;
    run: () => void;
    disabled?: boolean;
    dismiss?: boolean;
};
export type ToolsSide = 'left' | 'right';

export const FOOTER_ROW_HEIGHT = 52;
const KEY = 44;
const PANEL_PADDING = 4;
// A sideways pull past this flips the dock; anything shorter is a tap.
const FLIP_DISTANCE = 40;
/** The card's width where the window allows it; narrower windows take the width minus the margins. */
const PANEL_WIDTH = 320;

/** The glyph a strip key shows for a terminal command; the label stays its accessible name. */
const STRIP_GLYPH: Partial<Record<PanelGlyphName, React.ComponentProps<typeof Ionicons>['name']>> = { keyboard: 'keypad-outline', reset: 'refresh-outline', close: 'close-outline' };
const STRIP_WORD: Partial<Record<PanelGlyphName, string>> = { minus: '\u2212', plus: '+' };

/**
 * One key in the card's strip across the top: a 44dp control with one
 * outline glyph at 20dp (or the bare zoom sign), the register every
 * control on this screen keeps.
 */
function StripKey({ glyph, label, onPress, disabled = false }: { glyph: PanelGlyphName; label: string; onPress: () => void; disabled?: boolean }) {
    const { theme } = useUnistyles();
    const word = STRIP_WORD[glyph];
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => ({
                width: KEY, height: KEY, borderRadius: 8,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                opacity: disabled ? 0.35 : 1,
            })}
        >
            {word === undefined
                ? <Ionicons name={STRIP_GLYPH[glyph] ?? 'ellipse-outline'} size={20} color={theme.colors.text} />
                : <Text style={{ fontSize: 20, lineHeight: 24, color: theme.colors.text }}>{word}</Text>}
        </Pressable>
    );
}

/** The floating trigger's size and its distance from the terminal's edge. */
export const TOOLS_TRIGGER_SIZE = 36;
export const TOOLS_TRIGGER_MARGIN = 8;
/**
 * The inset the terminal keeps at its bottom: the grid ends this far above
 * the container's edge, so the mark, which sits on the terminal at the
 * thumb, never has an output row underneath it. Jump to bottom uses the
 * same inset at the other corner.
 */
export const TOOLS_TRIGGER_INSET = TOOLS_TRIGGER_SIZE + 2 * TOOLS_TRIGGER_MARGIN;

/**
 * The trigger: one small floating icon over the terminal, in the thumb
 * zone -- the corner just above the footer, on the side the holding hand
 * prefers. It carries an identity (options: the controls for this
 * terminal), not a dot triple, and it is a mark, not a disc: 36dp at the
 * edge, translucent, and it dims while the output is being read back so
 * it never hides a line that matters. Dragging it sideways moves it to the
 * other edge; the same move is offered as an accessibility action. While
 * its card is open the card sits over it; a second tap on the same spot
 * (the card's own close) closes it.
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
    // A touch on the mark is the mark's: a sideways drag docks it and must
    // never also read as the pane's own swipe to the next agent. Natively the
    // touch stops here; on the web the pane's listener recognises the mark
    // by id (stopping the DOM event would starve the responder system, which
    // listens at the document, and the drag itself).
    const swallow = Platform.OS === 'web' ? undefined : (event: { stopPropagation: () => void }): void => event.stopPropagation();
    return (
        <View {...drag.panHandlers} collapsable={false}
            onTouchStart={swallow} onTouchMove={swallow} onTouchEnd={swallow}
            nativeID={PANE_GESTURE_IGNORE_ID}
            style={{ position: 'absolute', bottom: TOOLS_TRIGGER_MARGIN, [side]: TOOLS_TRIGGER_MARGIN }}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={blocked ? 'Hide keyboard to open terminal quick actions' : expanded ? 'Close terminal quick actions' : 'Terminal quick actions'}
                accessibilityHint={`Drag sideways to move to the ${other}.`}
                accessibilityState={{ expanded }}
                accessibilityActions={[{ name: 'move', label: `Move Tools to the ${other}` }]}
                onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'move') onSideChange(other); }}
                onPress={onPress}
                hitSlop={6}
                style={({ pressed }) => ({
                    width: TOOLS_TRIGGER_SIZE, height: TOOLS_TRIGGER_SIZE, borderRadius: 10,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: theme.colors.surfaceHigh,
                    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
                    opacity: pressed ? 0.7 : expanded ? 1 : dimmed ? 0.35 : 0.88,
                })}
            >
                <Ionicons name="options-outline" size={20} color={theme.colors.text} />
            </Pressable>
        </View>
    );
}

/**
 * The open card: a compact rounded card floating over the terminal, its
 * corner on the mark that opened it (the hand's side, just above the
 * footer), elevated above the output rows it partly covers. Across its top
 * the strip: the terminal's own keyboard and zoom, then the close, as 44dp
 * glyph keys; a hairline; then the labelled rows with their data inline,
 * one line each, sized to content. The card has no internal scroll region:
 * every rendered row contributes to its height, even when the available
 * terminal area is short. A tap on the terminal, Back and Escape close it
 * too.
 */
export function TerminalToolsPanel({ commands, side, onClose, children }: {
    commands: readonly TerminalCommand[];
    side: ToolsSide;
    /** Retained for the shared caller while the footer owns terminal geometry; the card sizes to content. */
    maxHeight: number;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    return (
        <View accessibilityRole="menu" accessibilityLabel="Terminal quick actions"
            style={{
                position: 'absolute', bottom: TOOLS_TRIGGER_MARGIN, [side]: TOOLS_TRIGGER_MARGIN,
                width: Math.min(PANEL_WIDTH, width - 2 * TOOLS_TRIGGER_MARGIN),
                borderRadius: 14, overflow: 'hidden',
                backgroundColor: theme.colors.surfaceHigh,
                borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
                elevation: 12,
                shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PANEL_PADDING, paddingVertical: PANEL_PADDING }}>
                {commands.map((command) => (
                    <StripKey key={command.icon} glyph={command.icon} label={command.label} disabled={command.disabled === true}
                        onPress={() => { if (command.dismiss) onClose(); command.run(); }} />
                ))}
                <StripKey glyph="close" label="Close terminal quick actions" onPress={onClose} />
            </View>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }} />
            <View style={{ paddingVertical: PANEL_PADDING }}>
                {children}
            </View>
        </View>
    );
}
