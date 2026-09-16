import * as React from 'react';
import { BackHandler, Keyboard, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/catalog/store';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { hapticsLight } from '@/components/haptics';
import { AnimatedPopup } from '@/components/AnimatedOverlay';
import type { Theme } from '@/theme';
import type { PanelGlyphName } from '@/components/ActionShortcut';

export type TerminalCommand = {
    label: string;
    icon: PanelGlyphName;
    run: () => void;
    disabled?: boolean;
    dismiss?: boolean;
};

const KEY = 48;
const KEY_ICON = 20;
const KEY_EDGE = 16;
// The untouched puck rests a thumb-reach above the bottom edge, clear of the
// jump-to-bottom pill that lives at the corner.
const KEY_DEFAULT_BOTTOM_PAD = 64;
const PANEL_WIDTH = 268;
const OPEN_MARGIN = 12;
const BUTTON = 44;
const PANEL_PADDING = 4;
const DIVIDER = 1 + 4; // 1dp rule with 2dp margins on each side
const SLOT_RADIUS = 10;
const ICON = 20;

/** Where the puck or the open panel rests, as fractions of its travel range inside the terminal. */
type Dock = { fx: number; fy: number };
type DragHandlers = ReturnType<typeof PanResponder.create>['panHandlers'];
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

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
 * The one way into the terminal's quick actions: a floating command puck over
 * the terminal itself, in the app's own glass language, carrying the
 * sparkles mark that reads as a command palette rather than an overflow menu.
 * Drag it anywhere on the terminal; where it rests is remembered across
 * sessions. Tapping it expands the command panel beside it.
 */
function CommandPuck({ open, onPress, dragHandlers, style }: {
    open: boolean;
    onPress: () => void;
    dragHandlers: DragHandlers;
    style: ReturnType<typeof useAnimatedStyle>;
}) {
    const { theme } = useUnistyles();
    return (
        <Animated.View {...dragHandlers} collapsable={false}
            onTouchStart={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            style={[{ position: 'absolute', top: 0, left: 0, width: KEY, height: KEY }, style]}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={open ? 'Close terminal quick actions' : 'Terminal quick actions'}
                accessibilityHint="Quick terminal actions and view controls. Drag to move; tap to open."
                accessibilityState={{ expanded: open }}
                onPress={() => { hapticsLight(); onPress(); }}
                hitSlop={6}
                style={({ pressed }) => ({
                    width: KEY, height: KEY, borderRadius: KEY / 2,
                    alignItems: 'center', justifyContent: 'center',
                    opacity: pressed ? 0.78 : 1,
                    transform: [{ scale: pressed ? 0.94 : 1 }],
                })}
            >
                {Platform.OS === 'web'
                    ? <View style={{
                        width: KEY, height: KEY, borderRadius: KEY / 2,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: theme.colors.glass.backgroundStrong,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: open ? theme.colors.accent : theme.colors.glass.border,
                        shadowColor: theme.colors.glass.shadow, shadowOffset: { width: 0, height: 8 },
                        shadowRadius: 18, shadowOpacity: 1,
                    }}>
                        <Ionicons name={open ? 'close' : 'sparkles'} size={KEY_ICON} color={theme.colors.text} />
                    </View>
                    : <MobileGlassSurface intensity={76} interactive={false} style={{
                        width: KEY, height: KEY, borderRadius: KEY / 2,
                        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                        backgroundColor: open ? theme.colors.glass.backgroundStrong : theme.colors.glass.backgroundSubtle,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: open ? theme.colors.accent : theme.colors.glass.border,
                    }}>
                        <Ionicons name={open ? 'close' : 'sparkles'} size={KEY_ICON} color={theme.colors.text} />
                    </MobileGlassSurface>}
            </Pressable>
        </Animated.View>
    );
}

/**
 * The command palette: a floating card the puck expands into, rendered on
 * the terminal itself. Across its top the strip -- the terminal's own view
 * controls, then close, as 44dp glyph keys; a hairline; then the
 * quick-action rows, measured to content and scrolling only when the
 * terminal is too short to hold them. The card drags by any edge the action
 * list does not claim, and where it is dropped is remembered across
 * sessions. A tap on the terminal (rendered by the caller) and Back close it.
 */
export function FloatingTerminalControls({ open, onOpenChange, width, height, commands, renderQuickActions, dismissKeyboard }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Terminal surface width: puck and panel stay inside it. */
    width: number;
    /** Terminal surface height: shrinks under the keyboard, which keeps both above it. */
    height: number;
    commands: readonly TerminalCommand[];
    renderQuickActions?: (close: () => void) => React.ReactNode;
    /** Close the terminal's own IME when the panel cannot fit otherwise. */
    dismissKeyboard?: () => void;
}) {
    const { theme } = useUnistyles();
    const [keyDock, setKeyDock] = useLocalSettingMutable('terminalCommandKeyDock');
    const [panelDock, setPanelDock] = useLocalSettingMutable('terminalPanelDock');
    const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);

    const hasViewRow = commands.length > 0;
    const hasActions = renderQuickActions !== undefined;
    const panelWidth = Math.min(PANEL_WIDTH, Math.max(0, width - OPEN_MARGIN * 2));
    const headerHeight = PANEL_PADDING * 2 + BUTTON + (hasActions ? DIVIDER : 0);
    const [contentHeight, setContentHeight] = React.useState<number>();
    const measured = !hasActions || contentHeight !== undefined;
    const naturalHeight = headerHeight + (contentHeight ?? 0);
    const available = Math.max(headerHeight, height - OPEN_MARGIN * 2);
    const fits = measured && naturalHeight <= available;
    const [revealClamped, setRevealClamped] = React.useState(false);
    // Nothing is painted until every row has its full height, so a common
    // action is never revealed clipped.
    const painted = fits || revealClamped;
    const panelHeight = measured ? Math.min(naturalHeight, available) : headerHeight;
    const actionsMaxHeight = Math.max(0, available - headerHeight);

    // Puck position in terminal coordinates, plus its start for the drag.
    const keyX = useSharedValue(0), keyY = useSharedValue(0);
    const keyStartX = useSharedValue(0), keyStartY = useSharedValue(0);
    const panelX = useSharedValue(0), panelY = useSharedValue(0);
    const panelStartX = useSharedValue(0), panelStartY = useSharedValue(0);
    // The fraction form is what survives app restarts and terminal resizes.
    const keyFrac = React.useRef<Dock>(keyDock ?? { fx: 1, fy: 1 });
    const keyDefaulted = React.useRef(keyDock === null);
    const panelPlaced = React.useRef(false);

    const keyRange = React.useCallback(() => ({
        rx: Math.max(0, width - KEY - KEY_EDGE * 2),
        ry: Math.max(0, height - KEY - KEY_EDGE * 2),
    }), [width, height]);
    const placeKey = React.useCallback(() => {
        const { rx, ry } = keyRange();
        keyX.value = KEY_EDGE + clamp01(keyFrac.current.fx) * rx;
        keyY.value = KEY_EDGE + clamp01(keyFrac.current.fy) * ry
            - (keyDefaulted.current ? Math.min(KEY_DEFAULT_BOTTOM_PAD, Math.max(0, ry)) : 0);
    }, [keyRange, keyX, keyY]);
    const keyToFrac = (): Dock => {
        const { rx, ry } = keyRange();
        return { fx: clamp01(rx === 0 ? 1 : (keyX.value - KEY_EDGE) / rx), fy: clamp01(ry === 0 ? 1 : (keyY.value - KEY_EDGE) / ry) };
    };

    // Every terminal resize (rotation, keyboard, split) re-clamps both into
    // the surface they live on, so neither can strand off-screen or under
    // the keyboard: the region itself ends above the IME.
    React.useEffect(() => {
        placeKey();
        if (open && panelPlaced.current) {
            panelX.value = OPEN_MARGIN + clamp01(panelDock?.fx ?? 0) * Math.max(0, width - panelWidth - OPEN_MARGIN * 2);
            panelY.value = OPEN_MARGIN + clamp01(panelDock?.fy ?? 0) * Math.max(0, height - panelHeight - OPEN_MARGIN * 2);
        }
    }, [placeKey, width, height, open, panelX, panelY, panelWidth, panelHeight, panelDock]);

    React.useEffect(() => { if (!open) panelPlaced.current = false; }, [open]);

    // Open: the panel grows out of the puck -- centred above it, falling
    // below when there is no headroom -- unless the person put it somewhere
    // else before; that spot wins. Derived from the puck's fractions, so the
    // placement never depends on effect ordering against the puck's layout.
    React.useEffect(() => {
        if (!open || !measured || panelPlaced.current) return;
        panelPlaced.current = true;
        if (panelDock) {
            panelX.value = OPEN_MARGIN + clamp01(panelDock.fx) * Math.max(0, width - panelWidth - OPEN_MARGIN * 2);
            panelY.value = OPEN_MARGIN + clamp01(panelDock.fy) * Math.max(0, height - panelHeight - OPEN_MARGIN * 2);
            return;
        }
        const rx = Math.max(0, width - panelWidth - OPEN_MARGIN * 2);
        const ry = Math.max(0, height - panelHeight - OPEN_MARGIN * 2);
        const { rx: krx, ry: kry } = keyRange();
        const keyPx = KEY_EDGE + clamp01(keyFrac.current.fx) * krx;
        const keyPy = KEY_EDGE + clamp01(keyFrac.current.fy) * kry
            - (keyDefaulted.current ? Math.min(KEY_DEFAULT_BOTTOM_PAD, Math.max(0, kry)) : 0);
        let x = keyPx + KEY / 2 - panelWidth / 2;
        let y = keyPy - panelHeight - 8;
        if (y < OPEN_MARGIN) y = keyPy + KEY + 8;
        panelX.value = Math.max(OPEN_MARGIN, Math.min(OPEN_MARGIN + rx, x));
        panelY.value = Math.max(OPEN_MARGIN, Math.min(OPEN_MARGIN + ry, y));
    }, [open, measured, panelDock, panelX, panelY, panelWidth, panelHeight, width, height, keyRange]);

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
        if (!open || !measured || fits) { setRevealClamped(false); return; }
        dismiss();
        const timer = setTimeout(() => setRevealClamped(true), 400);
        return () => clearTimeout(timer);
    }, [dismiss, fits, measured, open]);
    React.useEffect(() => {
        if (!open || Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
        return () => subscription.remove();
    }, [close, open]);

    // A drag owns the gesture, so releasing it cannot open the palette; the
    // capture phase keeps the pane's own agent-swipe out of the puck.
    const keyDrag = React.useRef(PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) => gesture.numberActiveTouches === 1 && Math.hypot(gesture.dx, gesture.dy) >= 8,
        onPanResponderGrant: () => { keyStartX.value = keyX.value; keyStartY.value = keyY.value; },
        onPanResponderMove: (_event, gesture) => {
            const { rx, ry } = keyRange();
            keyX.value = KEY_EDGE + Math.max(0, Math.min(rx, keyStartX.value - KEY_EDGE + gesture.dx));
            keyY.value = KEY_EDGE + Math.max(0, Math.min(ry, keyStartY.value - KEY_EDGE + gesture.dy));
        },
        onPanResponderRelease: () => { keyFrac.current = keyToFrac(); keyDefaulted.current = false; setKeyDock(keyFrac.current); },
        onPanResponderTerminationRequest: () => false,
    })).current;
    // The panel yields its vertical scroll to the action list and takes the
    // gestures the list declines -- edges, header, and every horizontal pull.
    const panelRange = React.useCallback(() => ({
        rx: Math.max(0, width - panelWidth - OPEN_MARGIN * 2),
        ry: Math.max(0, height - panelHeight - OPEN_MARGIN * 2),
    }), [width, height, panelWidth, panelHeight]);
    const panelDrag = React.useRef(PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => gesture.numberActiveTouches === 1 && (Math.abs(gesture.dx) >= 8 || Math.abs(gesture.dy) >= 8),
        onPanResponderGrant: () => { panelStartX.value = panelX.value; panelStartY.value = panelY.value; },
        onPanResponderMove: (_event, gesture) => {
            const { rx, ry } = panelRange();
            panelX.value = OPEN_MARGIN + Math.max(0, Math.min(rx, panelStartX.value - OPEN_MARGIN + gesture.dx));
            panelY.value = OPEN_MARGIN + Math.max(0, Math.min(ry, panelStartY.value - OPEN_MARGIN + gesture.dy));
        },
        onPanResponderRelease: () => {
            const { rx, ry } = panelRange();
            setPanelDock({ fx: clamp01(rx === 0 ? 0 : (panelX.value - OPEN_MARGIN) / rx), fy: clamp01(ry === 0 ? 0 : (panelY.value - OPEN_MARGIN) / ry) });
        },
        onPanResponderTerminationRequest: () => false,
    })).current;

    const keyPosition = useAnimatedStyle(() => ({ transform: [{ translateX: keyX.value }, { translateY: keyY.value }] }));
    const panelPosition = useAnimatedStyle(() => ({ transform: [{ translateX: panelX.value }, { translateY: panelY.value }] }));

    if (!hasViewRow && !hasActions) return null;
    const runCommand = (command: TerminalCommand) => () => { if (command.dismiss) close(); command.run(); };

    return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {open && <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={close} />}
            {open && (
                <Animated.View
                    {...panelDrag.panHandlers} collapsable={false}
                    accessibilityRole="menu" accessibilityLabel="Terminal quick actions"
                    onTouchStart={(event) => event.stopPropagation()}
                    onTouchMove={(event) => event.stopPropagation()}
                    onTouchEnd={(event) => event.stopPropagation()}
                    style={[{ position: 'absolute', top: 0, left: 0, width: panelWidth }, panelPosition]}
                >
                    <AnimatedPopup style={{
                        height: panelHeight, borderRadius: 14, overflow: 'hidden',
                        backgroundColor: theme.colors.surface,
                        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
                        elevation: 12,
                    }}>
                        <View style={{ flex: 1, opacity: painted ? 1 : 0 }}>
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
                                onPress={close}>
                                <CommandGlyph name="close" size={ICON} color={theme.colors.surface} />
                            </Pressable>
                        </View>
                        {hasActions && <View style={{ height: 1, marginVertical: 2, marginHorizontal: 6, backgroundColor: theme.colors.divider }} />}
                        {hasActions && <ScrollView style={measured ? { maxHeight: actionsMaxHeight } : undefined}
                            onContentSizeChange={(_width, measuredHeight) => setContentHeight(Math.ceil(measuredHeight))}
                            scrollEnabled={!fits} nestedScrollEnabled keyboardShouldPersistTaps="always">
                            {renderQuickActions(close)}
                        </ScrollView>}
                        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }]} />
                        </View>
                    </AnimatedPopup>
                </Animated.View>
            )}
            <CommandPuck open={open} onPress={() => onOpenChange(!open)} dragHandlers={keyDrag.panHandlers} style={keyPosition} />
        </View>
    );
}
