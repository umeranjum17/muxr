import * as React from 'react';
import { BackHandler, Keyboard, PanResponder, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { PanelGlyph, PanelIcon, panelPalette, type PanelGlyphName } from '@/components/ActionShortcut';

export type TerminalCommand = {
    label: string;
    icon: PanelGlyphName;
    run: () => void;
    disabled?: boolean;
    dismiss?: boolean;
};
// Keep the closed key compact while retaining a 44dp touch target: the box
// stays 44, the painted disc is the 38dp the terminal's own jump-to-bottom
// control already uses.
const KEY = 44;
const KEY_DISC = 38;
const BUTTON = 44;
const PANEL_WIDTH = 268;
// Keep the entire drag target outside Android's system back-gesture edge. The
// open panel is not a drag target, so it sits at the design's own margin.
const EDGE = 32;
const OPEN_MARGIN = 16;
// Where the key rests until someone moves it: the design's bottom-right anchor.
const DEFAULT_BOTTOM = 28;
const GAP = 8;
const PANEL_PADDING = 4;
const DIVIDER = 1 + 4; // 1dp rule with 2dp margins on each side
const SLOT_RADIUS = 10;
const ICON = 24;
const KEY_ICON = 18;

type Palette = ReturnType<typeof panelPalette>;

// The closed key is a raised light control carrying the app's own overflow
// glyph, not a dark pill: it belongs to the panel it opens.
const keyStyle = (panel: Palette, pressed: boolean) => ({
    width: KEY_DISC, height: KEY_DISC, borderRadius: KEY_DISC / 2,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    backgroundColor: pressed ? panel.pressed : panel.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: panel.border,
    elevation: 4,
    transform: [{ scale: pressed ? .96 : 1 }],
});

// Every slot in the panel's top row is the same width, so the four view
// controls and Close read as one evenly divided strip. Longhands, not the
// `flex` shorthand: on web `flex: 0` resolves to a zero basis and collapses
// the lone Close slot to no width at all.
const slotStyle = (panel: Palette, pressed: boolean, { disabled = false, grow = true } = {}) => ({
    flexGrow: grow ? 1 : 0, flexShrink: 0, flexBasis: BUTTON, minWidth: BUTTON,
    height: BUTTON, borderRadius: SLOT_RADIUS,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    backgroundColor: pressed ? panel.pressed : 'transparent',
    opacity: disabled ? .32 : 1,
    transform: [{ scale: pressed ? .96 : 1 }],
});

/**
 * One movable command key. Opening it shows a single panel anchored to the
 * key: the view controls and Close share the top row, quick actions stack
 * below as full-width labelled rows. The panel opens upward when the key sits
 * in the lower half and downward when it sits in the upper half, and stays
 * clamped to the region it is given without moving the key itself.
 */
export function FloatingTerminalControls({ width, height, overlayHeight, dismissKeyboard, commands, renderQuickActions, hidden = false }: {
    width: number;
    /** Terminal region: the key never leaves it. */
    height: number;
    /** Terminal plus the inert accessory row the open panel may cover. */
    overlayHeight?: number;
    /** Close the terminal's own IME, where the platform has one. */
    dismissKeyboard?: () => void;
    commands: TerminalCommand[];
    renderQuickActions?: (close: () => void) => React.ReactNode;
    hidden?: boolean;
}) {
    const { theme } = useUnistyles();
    const panel = panelPalette(theme);
    const [expanded, setExpanded] = React.useState(false);
    const [opensUpward, setOpensUpward] = React.useState(false);
    const hasViewRow = commands.length > 0;
    const hasActions = renderQuickActions !== undefined;
    // The panel may spill over the accessory key row, which is inert beneath
    // it; it never reaches the composer, header or keyboard.
    const region = overlayHeight ?? height;
    // The header (view controls and Close) always leads the panel; the rows
    // are measured before the panel is shown, so it never opens scrolled.
    const headerHeight = PANEL_PADDING * 2 + BUTTON + (hasActions ? DIVIDER : 0);
    const [contentHeight, setContentHeight] = React.useState<number>();
    const measured = !hasActions || contentHeight !== undefined;
    const naturalHeight = headerHeight + (contentHeight ?? 0);
    const available = Math.max(headerHeight, region - OPEN_MARGIN * 2);
    const fits = measured && naturalHeight <= available;
    const [revealClamped, setRevealClamped] = React.useState(false);
    // Nothing is painted until every row has its full height, so a common
    // action is never revealed clipped.
    const painted = fits || revealClamped;
    const panelHeight = measured ? Math.min(naturalHeight, available) : headerHeight;
    const actionsMaxHeight = Math.max(0, available - headerHeight);
    // Only the key has to fit: a region too short for the panel gives the
    // keyboard's space back instead of hiding the control.
    const visible = !hidden && width >= KEY + EDGE * 2 && height >= KEY + GAP * 2;
    const open = expanded && visible;
    const panelWidth = Math.min(PANEL_WIDTH, width - OPEN_MARGIN * 2);
    const boxWidth = open ? panelWidth : KEY;
    const boxHeight = open ? panelHeight : KEY;
    const x = useSharedValue(0), y = useSharedValue(0);
    const startX = useSharedValue(0), startY = useSharedValue(0);
    const placed = useSharedValue(false);
    // The key keeps its own drifted placement; the open panel only derives a
    // clamped display position from it, so closing restores where the user
    // left the key.
    const dragMinX = EDGE, dragMaxX = Math.max(dragMinX, width - EDGE - KEY);
    const dragMinY = GAP, dragMaxY = Math.max(dragMinY, height - GAP - KEY);
    const close = React.useCallback(() => setExpanded(false), []);
    React.useEffect(() => { if (hidden) setExpanded(false); }, [hidden]);
    React.useEffect(() => {
        if (!visible) return;
        x.value = placed.value ? Math.max(dragMinX, Math.min(dragMaxX, x.value)) : dragMaxX;
        y.value = placed.value ? Math.max(dragMinY, Math.min(dragMaxY, y.value)) : Math.max(dragMinY, Math.min(dragMaxY, height - DEFAULT_BOTTOM - KEY));
        placed.value = true;
    }, [visible, dragMinX, dragMaxX, dragMinY, dragMaxY, height, placed, x, y]);
    // Both calls are needed, and neither replaces the other: the native one
    // takes the IME down on the terminal's window whichever view raised it,
    // while only the React Native module drops the composer's focus, without
    // which its keyboard comes straight back.
    const dismiss = React.useCallback(() => {
        dismissKeyboard?.();
        Keyboard.dismiss();
    }, [dismissKeyboard]);
    // Concept B never scrolls its rows or drops one. When the terminal plus
    // the accessory row still cannot hold the panel, the keyboard's space is
    // taken back; the panel's own Keyboard button returns it.
    React.useEffect(() => {
        if (!open) { setRevealClamped(false); return; }
        if (!measured || fits) return;
        dismiss();
        // If that space never arrives — no native dismissal, or a region too
        // short even without a keyboard — show the panel scrolled rather than
        // leave a tap that painted nothing at all.
        const timer = setTimeout(() => setRevealClamped(true), 400);
        return () => clearTimeout(timer);
    }, [dismiss, fits, measured, open]);
    React.useEffect(() => {
        if (!open || Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
        return () => subscription.remove();
    }, [close, open]);
    // A drag owns the gesture, so releasing it cannot activate a command.
    const drag = PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) => gesture.numberActiveTouches === 1 && Math.hypot(gesture.dx, gesture.dy) >= 8,
        onPanResponderGrant: () => { startX.value = x.value; startY.value = y.value; },
        onPanResponderMove: (_event, gesture) => {
            x.value = Math.max(dragMinX, Math.min(dragMaxX, startX.value + gesture.dx));
            y.value = Math.max(dragMinY, Math.min(dragMaxY, startY.value + gesture.dy));
        },
        onPanResponderTerminationRequest: () => false,
    });
    // Open, the panel sits flush against the key's edge and is clamped into
    // the region; the key's own coordinates are never touched.
    const position = useAnimatedStyle(() => ({
        transform: [
            { translateX: open ? Math.max(OPEN_MARGIN, Math.min(width - OPEN_MARGIN - boxWidth, x.value)) : x.value },
            { translateY: open ? Math.max(OPEN_MARGIN, Math.min(region - OPEN_MARGIN - boxHeight, opensUpward ? y.value + KEY - boxHeight : y.value)) : y.value },
        ],
    }));
    if (!visible || (!hasViewRow && !hasActions)) return null;
    const runCommand = (command: TerminalCommand) => () => { if (command.dismiss) close(); command.run(); };
    const openPanel = () => {
        // Grow away from the nearest vertical edge; the clamp keeps whatever
        // the panel turns out to measure inside the region.
        setOpensUpward(y.value + KEY / 2 >= height / 2);
        setExpanded(true);
    };
    return <>
        {open && <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={close} />}
        <Animated.View accessibilityRole="toolbar" accessibilityLabel="Terminal controls"
            onTouchStart={(event) => event.stopPropagation()} onTouchMove={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}
            style={[{ position: 'absolute', top: 0, left: 0, width: boxWidth, height: boxHeight }, position]}>
            {/* Until the rows report their size the panel lays out unclamped and
                unpainted, so it is never revealed in a scrolled state. */}
            {open && <View pointerEvents={painted ? 'auto' : 'none'}
                style={{ borderRadius: 16, backgroundColor: panel.surface, overflow: 'hidden', elevation: 8, padding: PANEL_PADDING, opacity: painted ? 1 : 0 }}>
                <View style={{ height: BUTTON, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    {commands.map((command) => <Pressable key={command.label} accessibilityRole="button" accessibilityLabel={command.label}
                        accessibilityState={{ disabled: !!command.disabled }} disabled={command.disabled} onPress={runCommand(command)}
                        style={({ pressed }) => slotStyle(panel, pressed, { disabled: command.disabled === true })}>
                        <PanelGlyph name={command.icon} size={ICON} color={panel.text} />
                    </Pressable>)}
                    {/* Close is the row's fifth slot. With no view commands to
                        divide the row it keeps one slot's width instead of
                        stretching across the panel. */}
                    <Pressable accessibilityRole="button" accessibilityLabel="Close terminal controls"
                        style={({ pressed }) => ({ ...slotStyle(panel, pressed, { grow: hasViewRow }), ...(hasViewRow ? {} : { marginLeft: 'auto' as const }), backgroundColor: panel.keyFill })}
                        onPress={close}>
                        <PanelGlyph name="close" size={ICON} color={panel.keyTint} />
                    </Pressable>
                </View>
                {hasActions && <View style={{ height: 1, marginVertical: 2, marginHorizontal: 6, backgroundColor: panel.divider }} />}
                {hasActions && <ScrollView style={measured ? { maxHeight: actionsMaxHeight } : undefined}
                    onContentSizeChange={(_width, measuredHeight) => setContentHeight(Math.ceil(measuredHeight))}
                    scrollEnabled={!fits} nestedScrollEnabled keyboardShouldPersistTaps="always">
                    {renderQuickActions(close)}
                </ScrollView>}
                <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: panel.border }]} />
            </View>}
            {!open && <View {...drag.panHandlers} collapsable={false} style={{ width: KEY, height: KEY }}>
                <Pressable accessibilityRole="button" accessibilityLabel="Show terminal controls"
                    accessibilityHint="Quick terminal controls. Drag to move; tap to open."
                    accessibilityState={{ expanded: open }} onPress={openPanel}
                    style={{ width: KEY, height: KEY, alignItems: 'center', justifyContent: 'center' }}>
                    {({ pressed }) => <View style={keyStyle(panel, pressed)}>
                        <PanelIcon icon="ellipsis-horizontal" size={KEY_ICON} color={panel.text} />
                    </View>}
                </Pressable>
            </View>}
        </Animated.View>
    </>;
}
