import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

function clamp(value: number, limit: number) {
    'worklet';
    return Math.max(-limit, Math.min(limit, value));
}

/** Zoom is relative to the fitted image; a tall screenshot can expand to reading width. */
export function ZoomableAttachmentImage({ uri, recyclingKey, width, height, onError, onZoomedChange }: {
    uri: string; recyclingKey: string; width: number; height: number;
    onError: () => void; onZoomedChange: (zoomed: boolean) => void;
}) {
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    const scale = useSharedValue(1);
    const x = useSharedValue(0);
    const y = useSharedValue(0);
    const startScale = useSharedValue(1);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    const anchorX = useSharedValue(0);
    const anchorY = useSharedValue(0);
    const fit = size.width > 0 && size.height > 0 ? Math.min(width / size.width, height / size.height) : 1;
    const fittedWidth = size.width > 0 ? size.width * fit : width;
    const fittedHeight = size.height > 0 ? size.height * fit : height;
    const readingScale = Math.min(20, Math.max(2, width / Math.max(1, fittedWidth)));
    const maxScale = Math.min(20, Math.max(6, readingScale * 2));

    React.useEffect(() => {
        scale.value = 1; x.value = 0; y.value = 0;
        onZoomedChange(false);
    }, [uri, width, height, scale, x, y, onZoomedChange]);

    const pinch = Gesture.Pinch()
        .onStart((event) => {
            startScale.value = scale.value;
            anchorX.value = (event.focalX - width / 2 - x.value) / scale.value;
            anchorY.value = (event.focalY - height / 2 - y.value) / scale.value;
            runOnJS(onZoomedChange)(true);
        })
        .onUpdate((event) => {
            const next = Math.max(1, Math.min(maxScale, startScale.value * event.scale));
            scale.value = next;
            x.value = clamp(event.focalX - width / 2 - anchorX.value * next, Math.max(0, (fittedWidth * next - width) / 2));
            y.value = clamp(event.focalY - height / 2 - anchorY.value * next, Math.max(0, (fittedHeight * next - height) / 2));
        })
        .onFinalize(() => { runOnJS(onZoomedChange)(scale.value > 1.01); });
    const pan = Gesture.Pan().maxPointers(1).manualActivation(true)
        .onTouchesMove((_event, manager) => {
            if (scale.value > 1.01) manager.activate(); else manager.fail();
        })
        .onStart(() => { startX.value = x.value; startY.value = y.value; })
        .onUpdate((event) => {
            x.value = clamp(startX.value + event.translationX, Math.max(0, (fittedWidth * scale.value - width) / 2));
            y.value = clamp(startY.value + event.translationY, Math.max(0, (fittedHeight * scale.value - height) / 2));
        });
    const doubleTap = Gesture.Tap().numberOfTaps(2)
        .onEnd((event, success) => {
            if (!success) return;
            const next = scale.value > 1.01 ? 1 : readingScale;
            x.value = withTiming(clamp((event.x - width / 2) * (1 - next), Math.max(0, (fittedWidth * next - width) / 2)));
            y.value = withTiming(clamp((event.y - height / 2) * (1 - next), Math.max(0, (fittedHeight * next - height) / 2)));
            scale.value = withTiming(next);
            runOnJS(onZoomedChange)(next > 1.01);
        });
    const transform = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));
    const zoomTo = (next: number) => {
        const value = Math.max(1, Math.min(maxScale, next));
        x.value = withTiming(clamp(x.value, Math.max(0, (fittedWidth * value - width) / 2)));
        y.value = withTiming(clamp(y.value, Math.max(0, (fittedHeight * value - height) / 2)));
        scale.value = withTiming(value);
        onZoomedChange(value > 1.01);
    };
    return <View style={{ width, height }}>
        <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
            <Animated.View style={{ width, height, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
                <Animated.View style={[{ width: fittedWidth, height: fittedHeight }, transform]}>
                    <Image source={{ uri }} recyclingKey={recyclingKey} contentFit="contain" style={{ width: '100%', height: '100%' }}
                        onLoad={(event) => setSize({ width: event.source.width, height: event.source.height })} onError={onError} />
                </Animated.View>
            </Animated.View>
        </GestureDetector>
        <View style={{ position: 'absolute', bottom: 4, alignSelf: 'center', flexDirection: 'row', gap: 8 }}>
            {([
                ['Zoom out', 'remove', () => zoomTo(scale.value / 1.5)],
                ['Fit image', 'scan-outline', () => zoomTo(1)],
                ['Zoom in', 'add', () => zoomTo(scale.value * 1.5)],
            ] as const).map(([label, icon, action]) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={action}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(35,35,38,0.9)', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={icon} size={22} color="#fff" />
            </Pressable>)}
        </View>
    </View>;
}
