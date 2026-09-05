import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

/** The handle owns movement; browser taps and toolbar button taps stay separate. */
export function FloatingTerminalControls({ width, height, children }: { width: number; height: number; children: React.ReactNode }) {
    const [collapsed, setCollapsed] = React.useState(false);
    const compactViewport = height < 100 || width < 60;
    const hidden = collapsed || compactViewport;
    const [size, setSize] = React.useState({ width: 44, height: 44 });
    const x = useSharedValue(0);
    const y = useSharedValue(0);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    const moved = useSharedValue(false);
    const maxX = Math.max(0, width - size.width - 8);
    const maxY = Math.max(0, height - size.height - 8);
    React.useEffect(() => {
        x.value = moved.value ? Math.max(0, Math.min(maxX, x.value)) : maxX;
        y.value = moved.value ? Math.max(0, Math.min(maxY, y.value)) : maxY / 2;
    }, [maxX, maxY, moved, x, y]);
    const drag = Gesture.Pan().minDistance(8)
        .onStart(() => { startX.value = x.value; startY.value = y.value; moved.value = true; })
        .onUpdate((event) => {
            x.value = Math.max(0, Math.min(maxX, startX.value + event.translationX));
            y.value = Math.max(0, Math.min(maxY, startY.value + event.translationY));
        });
    const position = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }] }));
    return <Animated.View accessibilityRole="toolbar" accessibilityLabel="Terminal controls"
        onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
        style={[{ position: 'absolute', top: 0, left: 0, gap: 6, flexDirection: height < 280 ? 'row' : 'column', flexWrap: 'wrap', maxWidth: Math.max(44, width - 16), opacity: width > 0 && height > 0 ? 1 : 0 }, position]}>
        <GestureDetector gesture={drag}>
            <View collapsable={false}>
                <Pressable accessibilityRole="button" accessibilityLabel={hidden ? 'Show terminal controls' : 'Hide terminal controls'}
                    accessibilityHint="Drag to move the toolbar. Tap to show or hide its buttons."
                    onPress={() => setCollapsed((value) => !value)}
                    style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(35,35,38,0.94)', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name={hidden ? 'options-outline' : 'reorder-four-outline'} size={22} color="#eee" />
                </Pressable>
            </View>
        </GestureDetector>
        {!hidden && children}
    </Animated.View>;
}
