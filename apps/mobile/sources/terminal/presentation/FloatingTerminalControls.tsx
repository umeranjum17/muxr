import * as React from 'react';
import { BackHandler, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { PanelGlyph, panelPalette, type PanelGlyphName } from '@/components/ActionShortcut';

export type TerminalCommand = {
    label: string;
    icon: PanelGlyphName;
    run: () => void;
    disabled?: boolean;
    dismiss?: boolean;
};
export type ToolsSide = 'left' | 'right';

/** The footer slot the Tools key owns; accessory keys scroll in the rest. */
export const TOOLS_SLOT_WIDTH = 76;
export const FOOTER_ROW_HEIGHT = 52;
const KEY_HEIGHT = 44;
const PANEL_WIDTH = 268;
const PANEL_MAX_HEIGHT = 237;
const ROW = 44;
const PANEL_PADDING = 4;
// A sideways pull past this flips the dock; anything shorter is a tap.
const FLIP_DISTANCE = 40;

/**
 * The Tools key: a labelled control in the footer's reserved slot, docked to
 * the side the holding hand prefers. It never floats over the terminal.
 * Dragging it sideways moves it to the other edge; the same move is offered
 * as an accessibility action.
 */
export function TerminalToolsKey({ side, onSideChange, onPress, blocked, expanded }: {
    side: ToolsSide;
    onSideChange: (side: ToolsSide) => void;
    onPress: () => void;
    /** The keyboard would not go down: say so on the key instead of opening nothing. */
    blocked: boolean;
    expanded: boolean;
}) {
    const { theme } = useUnistyles();
    const panel = panelPalette(theme);
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
        <View {...drag.panHandlers} collapsable={false} style={{ width: TOOLS_SLOT_WIDTH, height: KEY_HEIGHT, alignItems: 'center', justifyContent: 'center' }}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={blocked ? 'Hide keyboard to open Tools' : 'Tools'}
                accessibilityHint={`Drag sideways to dock on the ${other}.`}
                accessibilityState={{ expanded }}
                accessibilityActions={[{ name: 'move', label: `Move Tools to the ${other}` }]}
                onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'move') onSideChange(other); }}
                onPress={onPress}
                style={({ pressed }) => ({
                    height: KEY_HEIGHT, minWidth: 68, paddingHorizontal: 10, borderRadius: 12,
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                    backgroundColor: pressed ? panel.pressed : panel.surface,
                    borderWidth: StyleSheet.hairlineWidth, borderColor: panel.border,
                    elevation: 2,
                })}
            >
                <PanelGlyph name="tools" size={18} color={panel.text} />
                <Text style={{ ...Typography.default('semiBold'), fontSize: 13, color: panel.text }}>Tools</Text>
            </Pressable>
        </View>
    );
}

/**
 * The open Tools panel, in the footer where the composer and keys were: one
 * column of full-width rows docked to the key's side, at most 268dp wide and
 * a third of the screen tall, with Done pinned below the rows. Longer lists
 * scroll inside; rows never shrink to fit.
 */
export function TerminalToolsPanel({ side, bottomInset, onClose, children }: {
    side: ToolsSide;
    bottomInset: number;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const panel = panelPalette(theme);
    const { width, height } = useWindowDimensions();
    const panelWidth = Math.min(PANEL_WIDTH, width - 32);
    const maxHeight = Math.max(ROW * 2 + PANEL_PADDING * 2, Math.min(PANEL_MAX_HEIGHT, height / 3 - bottomInset - 8));
    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
        return () => subscription.remove();
    }, [onClose]);
    return (
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: bottomInset + 8, alignItems: side === 'left' ? 'flex-start' : 'flex-end', backgroundColor: theme.colors.surface }}>
            <View accessibilityRole="menu" accessibilityLabel="Tools"
                style={{ width: panelWidth, maxHeight, borderRadius: 16, padding: PANEL_PADDING, backgroundColor: panel.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: panel.border, elevation: 8, overflow: 'hidden' }}>
                <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="always" nestedScrollEnabled>
                    {children}
                </ScrollView>
                <View style={{ height: 1, marginVertical: 2, marginHorizontal: 6, backgroundColor: panel.divider }} />
                <Pressable accessibilityRole="button" accessibilityLabel="Done" onPress={onClose}
                    style={({ pressed }) => ({ height: ROW, borderRadius: 10, alignItems: side === 'left' ? 'flex-start' : 'flex-end', justifyContent: 'center', paddingHorizontal: 12, backgroundColor: pressed ? panel.pressed : 'transparent' })}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 15, color: panel.text }}>Done</Text>
                </Pressable>
            </View>
        </View>
    );
}
