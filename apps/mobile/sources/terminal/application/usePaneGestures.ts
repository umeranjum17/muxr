/**
 * One-finger horizontal swipes page through the working-agent buffer.
 * Vertical drags remain terminal scroll; multi-touch remains Ghostty zoom.
 */

import * as React from 'react';
import { Platform, type GestureResponderEvent, type View } from 'react-native';

export interface PaneGestureHandlers {
    onAgentSwipe: (direction: 'next' | 'prev') => void;
}

interface Point {
    x: number;
    y: number;
}

interface GestureState {
    start: Point;
    dx: number;
    dy: number;
}

const SWIPE_PX = 70;
const SWIPE_MAX_VERTICAL = 40;

/** Swipe right = previous agent, left = next agent. */
export function classifyAgentSwipe(gesture: { dx: number; dy: number }): 'next' | 'prev' | null {
    if (Math.abs(gesture.dx) < SWIPE_PX || Math.abs(gesture.dy) > SWIPE_MAX_VERTICAL) return null;
    return gesture.dx > 0 ? 'prev' : 'next';
}

function pointsOf(touches: TouchList): Point[] {
    return Array.from(touches, (touch) => ({ x: touch.clientX, y: touch.clientY }));
}

export function usePaneGestures(handlers: PaneGestureHandlers) {
    const handlersRef = React.useRef(handlers);
    handlersRef.current = handlers;
    const elementRef = React.useRef<View | null>(null);
    const gestureRef = React.useRef<GestureState | null>(null);

    const begin = React.useCallback((points: Point[]) => {
        // Multi-touch belongs to Ghostty's font zoom.
        gestureRef.current = points.length === 1 ? { start: points[0], dx: 0, dy: 0 } : null;
    }, []);

    const move = React.useCallback((points: Point[]) => {
        const gesture = gestureRef.current;
        if (gesture === null || points.length !== 1) return;
        gesture.dx = points[0].x - gesture.start.x;
        gesture.dy = points[0].y - gesture.start.y;
    }, []);

    const end = React.useCallback(() => {
        const gesture = gestureRef.current;
        gestureRef.current = null;
        if (gesture === null) return;
        const direction = classifyAgentSwipe(gesture);
        if (direction !== null) handlersRef.current.onAgentSwipe(direction);
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const node = elementRef.current as unknown as HTMLElement | null;
        if (node === null) return;
        const onStart = (event: TouchEvent): void => begin(pointsOf(event.touches));
        const onMove = (event: TouchEvent): void => move(pointsOf(event.touches));
        const onEnd = (): void => end();
        node.addEventListener('touchstart', onStart, { capture: true, passive: true });
        node.addEventListener('touchmove', onMove, { capture: true, passive: true });
        node.addEventListener('touchend', onEnd, { capture: true, passive: true });
        node.addEventListener('touchcancel', onEnd, { capture: true, passive: true });
        return () => {
            node.removeEventListener('touchstart', onStart, { capture: true });
            node.removeEventListener('touchmove', onMove, { capture: true });
            node.removeEventListener('touchend', onEnd, { capture: true });
            node.removeEventListener('touchcancel', onEnd, { capture: true });
        };
    }, [begin, end, move]);

    const nativeTouches = (event: GestureResponderEvent): Point[] => {
        const touches = event.nativeEvent.touches;
        return touches === undefined
            ? []
            : Array.from(touches, (touch) => ({ x: touch.pageX, y: touch.pageY }));
    };

    return {
        ref: elementRef,
        onTouchStart: (event: GestureResponderEvent) => {
            if (Platform.OS !== 'web') begin(nativeTouches(event));
        },
        onTouchMove: (event: GestureResponderEvent) => {
            if (Platform.OS !== 'web') move(nativeTouches(event));
        },
        onTouchEnd: () => {
            if (Platform.OS !== 'web') end();
        },
    };
}
