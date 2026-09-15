import * as React from 'react';
import { BackHandler, Keyboard, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { Theme } from '@/theme';
import type { PanelGlyphName } from '@/components/ActionShortcut';

export type TerminalCommand = {
    label: string;
    icon: PanelGlyphName;
    run: () => void;
    disabled?: boolean;
    dismiss?: boolean;
};

export type ToolsSide = 'left' | 'right';
/** The footer dock slot: a labelled 76x44 control, never an overlay over output. */
export const TOOLS_FOOTER_WIDTH = 76;
const TRIGGER_SIZE = 44;
const TRIGGER_MARGIN = 8;
const PANEL_WIDTH = 268;
const OPEN_MARGIN = 8;
const BUTTON = 44;
const PANEL_PADDING = 4;
const DIVIDER = 1 + 4; // 1dp rule with 2dp margins on each side
const SLOT_RADIUS = 10;
const ICON = 20;
// A sideways drag docks the trigger on the other footer edge.
const FLIP_DISTANCE = 24;

/** The glyph a command key shows for a terminal command; the label stays its accessible name. */
const STRIP_GLYPH: Partial<Record<PanelGlyphName, React.ComponentProps<typeof Ionicons>['name']>> = { keyboard: 'keypad-outline', reset: 'refresh-outline', close: 'close-outline' };
const STRIP_WORD: Partial<Record<PanelGlyphName, string>> = { minus: '−', plus: '+' };
function CommandGlyph({ name, size, color }: { name: PanelGlyphName; size: number; color: string }) {
    const word = STRIP_WORD[name];
    if (word !== undefined) return <Text style={{ fontSize: size, lineHeight: size + 4, color }}>{word}</Text>;
    return <Ionicons name={STRIP_GLYPH[name] ?? 'ellipse-outline'} size={size} color={color} />;
}

// Every slot in the panel's top row is the same width, so the view controls
// and Close read as one evenly divided strip. Longhands, not the `flex`
// shorthand: on web `flex: 0` resolves to a zero basis and collapses the lone
// Close slot to no width at all.
const slotStyle = (theme: Theme, pressed: boolean, { disabled = false, grow = true } = {}) => ({
    flexGrow: grow ? 1 : 0, flexShrink: 0, flexBasis: BUTTON, minWidth: BUTTON,
    height: BUTTON, borderRadius: SLOT_RADIUS,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
    opacity: disabled ? .32 : 1,
    transform: [{ scale: pressed ? .96 : 1 }],
});

/**
 * The trigger lives in the footer beside the terminal keys, where its label
 * can explain the action without covering output. It carries an identity
 * (Tools for this terminal), not a generic dot triple. Dragging it sideways
 * moves it to the other footer edge; the same move is offered as an
 * accessibility action.
 */
export function TerminalToolsTrigger({ side, onSideChange, onPress, expanded }: {
    side: ToolsSide;
    onSideChange: (side: ToolsSide) => void;
    onPress: () => void;
    expanded: boolean;
}) {
    const { theme } = useUnistyles();
    const [focused, setFocused] = React.useState(false);
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
    // A touch on the control is its own: a sideways drag docks it and must
    // never also read as the pane's swipe to the next agent.
    const swallow = (event: { stopPropagation: () => void }): void => event.stopPropagation();
    return (
        <View {...drag.panHandlers} collapsable={false}
            onTouchStart={swallow} onTouchMove={swallow} onTouchEnd={swallow}
            style={{ width: TOOLS_FOOTER_WIDTH, height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Close terminal quick actions' : 'Terminal quick actions'}
                accessibilityHint={`Drag sideways to move to the ${other}.`}
                accessibilityState={{ expanded }}
                accessibilityActions={[{ name: 'move', label: `Move Tools to the ${other}` }]}
                onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'move') onSideChange(other); }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onPress={onPress}
                hitSlop={6}
                style={({ pressed }) => ({
                    width: TOOLS_FOOTER_WIDTH, height: TRIGGER_SIZE, borderRadius: 10,
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                    paddingHorizontal: 10,
                    backgroundColor: expanded ? theme.colors.surfaceSelected : theme.colors.surfaceHigh,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: expanded || focused ? theme.colors.textSecondary : theme.colors.divider,
                    opacity: pressed ? 0.78 : 1,
                    transform: [{ scale: pressed ? 0.98 : 1 }],
                })}
            >
                <Ionicons name="terminal-outline" size={18} color={theme.colors.text} />
                <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '600' }}>Tools</Text>
            </Pressable>
        </View>
    );
}

/**
 * The open card: a compact rounded card anchored above the Tools footer
 * slot. Across its top the strip: the terminal's own view controls, then
 * the close, as 44dp glyph keys; a hairline; then the quick-action rows,
 * measured to content and scrolling only when the terminal is too short to
 * hold them. A tap on the terminal (rendered by the caller) and Back close
 * it too.
 */
export function TerminalToolsPanel({ commands, renderQuickActions, dismissKeyboard, side, width, maxHeight, onClose }: {
    commands: readonly TerminalCommand[];
    renderQuickActions?: (close: () => void) => React.ReactNode;
    /** Close the terminal's own IME when the panel cannot fit otherwise. */
    dismissKeyboard?: () => void;
    side: ToolsSide;
    /** Terminal container width: the card never runs past it. */
    width: number;
    /** Terminal container height: the card grows upward inside it. */
    maxHeight: number;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const hasViewRow = commands.length > 0;
    const hasActions = renderQuickActions !== undefined;
    // The header (view controls and Close) always leads the panel; the rows
    // are measured before the panel is shown, so it never opens scrolled.
    const headerHeight = PANEL_PADDING * 2 + BUTTON + (hasActions ? DIVIDER : 0);
    const [contentHeight, setContentHeight] = React.useState<number>();
    const measured = !hasActions || contentHeight !== undefined;
    const naturalHeight = headerHeight + (contentHeight ?? 0);
    const available = Math.max(headerHeight, maxHeight - OPEN_MARGIN * 2);
    const fits = measured && naturalHeight <= available;
    const [revealClamped, setRevealClamped] = React.useState(false);
    // Nothing is painted until every row has its full height, so a common
    // action is never revealed clipped.
    const painted = fits || revealClamped;
    const panelHeight = measured ? Math.min(naturalHeight, available) : headerHeight;
    const actionsMaxHeight = Math.max(0, available - headerHeight);
    // Both calls are needed, and neither replaces the other: the native one
    // takes the IME down on the terminal's window whichever view raised it,
    // while only the React Native module drops the composer's focus, without
    // which its keyboard comes straight back.
    const dismiss = React.useCallback(() => {
        dismissKeyboard?.();
        Keyboard.dismiss();
    }, [dismissKeyboard]);
    // When the terminal still cannot hold the panel, the keyboard's space is
    // taken back; the panel's own Keyboard button returns it. If that space
    // never arrives, show the panel scrolled rather than leave a tap that
    // painted nothing at all.
    React.useEffect(() => {
        if (!measured || fits) { setRevealClamped(false); return; }
        dismiss();
        const timer = setTimeout(() => setRevealClamped(true), 400);
        return () => clearTimeout(timer);
    }, [dismiss, fits, measured]);
    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
        return () => subscription.remove();
    }, [onClose]);
    const runCommand = (command: TerminalCommand) => () => { if (command.dismiss) onClose(); command.run(); };
    return (
        <View accessibilityRole="menu" accessibilityLabel="Terminal quick actions"
            style={{
                position: 'absolute', bottom: TRIGGER_MARGIN, [side]: TRIGGER_MARGIN,
                width: Math.min(PANEL_WIDTH, width - 2 * TRIGGER_MARGIN),
                height: panelHeight,
                borderRadius: 14, overflow: 'hidden',
                backgroundColor: theme.colors.surface,
                borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
                elevation: 12,
                opacity: painted ? 1 : 0,
            }}>
            <View style={{ height: BUTTON, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: PANEL_PADDING, paddingTop: PANEL_PADDING }}>
                {commands.map((command) => <Pressable key={command.label} accessibilityRole="button" accessibilityLabel={command.label}
                    accessibilityState={{ disabled: !!command.disabled }} disabled={command.disabled} onPress={runCommand(command)}
                    style={({ pressed }) => slotStyle(theme, pressed, { disabled: command.disabled === true })}>
                    <CommandGlyph name={command.icon} size={ICON} color={theme.colors.text} />
                </Pressable>)}
                {/* Close is the row's last slot. With no view commands to
                    divide the row it keeps one slot's width instead of
                    stretching across the panel. */}
                <Pressable accessibilityRole="button" accessibilityLabel="Close terminal quick actions"
                    style={({ pressed }) => ({ ...slotStyle(theme, pressed, { grow: hasViewRow }), ...(hasViewRow ? {} : { marginLeft: 'auto' as const }), backgroundColor: theme.colors.text })}
                    onPress={onClose}>
                    <CommandGlyph name="close" size={ICON} color={theme.colors.surface} />
                </Pressable>
            </View>
            {hasActions && <View style={{ height: 1, marginVertical: 2, marginHorizontal: 6, backgroundColor: theme.colors.divider }} />}
            {hasActions && <ScrollView style={measured ? { maxHeight: actionsMaxHeight } : undefined}
                onContentSizeChange={(_width, measuredHeight) => setContentHeight(Math.ceil(measuredHeight))}
                scrollEnabled={!fits} nestedScrollEnabled keyboardShouldPersistTaps="always">
                {renderQuickActions(onClose)}
            </ScrollView>}
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }]} />
        </View>
    );
}
