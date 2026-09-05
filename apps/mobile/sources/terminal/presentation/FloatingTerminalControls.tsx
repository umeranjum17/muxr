import * as React from 'react';
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

export type TerminalCommand = {
    label: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    run: () => void;
    disabled?: boolean;
    dismiss?: boolean;
};
const BUTTON = 44;
const RADIUS = 96;
const GAP = 8;
const buttonStyle = (pressed: boolean, disabled = false) => ({
    width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    backgroundColor: pressed ? '#454548' : 'rgba(28,28,30,0.96)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    opacity: disabled ? .45 : 1,
    transform: [{ scale: pressed ? .97 : 1 }],
});

/** One movable command puck. Its fan opens inward and stays inside the pane. */
export function FloatingTerminalControls({ width, height, commands }: { width: number; height: number; commands: TerminalCommand[] }) {
    const [expanded, setExpanded] = React.useState(false);
    const [opensRight, setOpensRight] = React.useState(false);
    const compact = width < RADIUS + BUTTON + GAP * 2 || height < RADIUS * 2 + BUTTON + GAP * 2;
    const visible = width >= BUTTON + GAP * 2 && height >= BUTTON + GAP * 2;
    const open = expanded && visible;
    const boxWidth = open ? compact ? Math.min(width - GAP * 2, 312) : RADIUS + BUTTON : BUTTON;
    const boxHeight = open && !compact ? RADIUS * 2 + BUTTON : BUTTON;
    const anchorX = open && !compact && !opensRight ? RADIUS : 0;
    const anchorY = open && !compact ? RADIUS : 0;
    const x = useSharedValue(0), y = useSharedValue(0);
    const startX = useSharedValue(0), startY = useSharedValue(0);
    const placed = useSharedValue(false);
    const minX = GAP + anchorX, maxX = Math.max(minX, width - GAP - boxWidth + anchorX);
    const minY = GAP + anchorY, maxY = Math.max(minY, height - GAP - boxHeight + anchorY);
    React.useEffect(() => {
        if (!visible) return;
        x.value = placed.value ? Math.max(minX, Math.min(maxX, x.value)) : maxX;
        y.value = placed.value ? Math.max(minY, Math.min(maxY, y.value)) : (minY + maxY) / 2;
        placed.value = true;
    }, [visible, minX, maxX, minY, maxY, placed, x, y]);
    React.useEffect(() => {
        if (!open || Platform.OS !== 'android') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setExpanded(false); return true; });
        return () => subscription.remove();
    }, [open]);
    const drag = Gesture.Pan().minDistance(8).maxPointers(1)
        .onStart(() => { startX.value = x.value; startY.value = y.value; })
        .onUpdate((event) => {
            x.value = Math.max(minX, Math.min(maxX, startX.value + event.translationX));
            y.value = Math.max(minY, Math.min(maxY, startY.value + event.translationY));
        });
    const position = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - anchorX }, { translateY: y.value - anchorY }] }));
    const button = (command: TerminalCommand) => <Pressable key={command.label} accessibilityRole="button" accessibilityLabel={command.label}
        accessibilityState={{ disabled: !!command.disabled }} disabled={command.disabled}
        onPress={() => { if (command.dismiss) setExpanded(false); command.run(); }}
        style={({ pressed }) => buttonStyle(pressed, command.disabled)}>
        <Ionicons name={command.icon} size={20} color="#eeeef0" />
    </Pressable>;
    if (!visible) return null;
    return <>
        {open && <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={() => setExpanded(false)} />}
        <Animated.View accessibilityRole="toolbar" accessibilityLabel="Terminal controls"
            onTouchStart={(event) => event.stopPropagation()} onTouchMove={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}
            style={[{ position: 'absolute', top: 0, left: 0, width: boxWidth, height: boxHeight }, position]}>
            {open && (compact
                ? <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
                    style={{ position: 'absolute', left: BUTTON + GAP, right: 0, top: 0 }} contentContainerStyle={{ gap: GAP }}>{commands.map(button)}</ScrollView>
                : commands.map((command, index) => {
                    const angle = commands.length === 1 ? 0 : -Math.PI / 2 + index * Math.PI / (commands.length - 1);
                    const left = opensRight ? RADIUS * Math.cos(angle) : RADIUS - RADIUS * Math.cos(angle);
                    const top = RADIUS + RADIUS * Math.sin(angle);
                    return <View key={command.label} style={{ position: 'absolute', left, top }}>{button(command)}</View>;
                }))}
            <GestureDetector gesture={drag}>
                <View collapsable={false} style={{ position: 'absolute', left: anchorX, top: anchorY, width: BUTTON, height: BUTTON }}>
                    <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Hide terminal controls' : 'Show terminal controls'}
                        accessibilityHint="Terminal commands. Drag to move; tap to open or close."
                        accessibilityState={{ expanded: open }} style={({ pressed }) => buttonStyle(pressed)}
                        onPress={() => { if (!open) setOpensRight(x.value < width / 2); setExpanded(!open); }}>
                        <Ionicons name={open ? 'close' : 'options-outline'} size={20} color="#eeeef0" />
                    </Pressable>
                </View>
            </GestureDetector>
        </Animated.View>
    </>;
}
