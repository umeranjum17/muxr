import * as React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

/**
 * Terminal gestures drawn as themselves: a fingertip where the finger lands,
 * and the way it travels. One small language for every row, so a list of
 * gestures reads as a list of motions rather than a list of icons.
 */
export type Gesture =
    | 'swipe'
    | 'swipe-two'
    | 'pinch'
    | 'tap'
    | 'hold'
    | 'scroll'
    | 'link'
    | 'control'
    | 'repeat'
    | 'edge'
    | 'stops';

const SIZE = 28;

function Fingertip({ x, y, color, r = 3.6 }: { x: number; y: number; color: string; r?: number }) {
    return (
        <>
            <Circle cx={x} cy={y} r={r + 3} fill={color} opacity={0.18} />
            <Circle cx={x} cy={y} r={r} fill={color} />
        </>
    );
}

/** A stroke from (x1, y1) to (x2, y2) with a chevron at its far end. */
function Travel({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = 3.4;
    const left = angle + Math.PI * 0.78;
    const right = angle - Math.PI * 0.78;
    return (
        <>
            <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
            <Path
                d={`M ${x2 + head * Math.cos(left)} ${y2 + head * Math.sin(left)} L ${x2} ${y2} L ${x2 + head * Math.cos(right)} ${y2 + head * Math.sin(right)}`}
                stroke={color}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
        </>
    );
}

function marks(gesture: Gesture, finger: string, motion: string): React.ReactNode {
    switch (gesture) {
        case 'swipe':
            return <>
                <Travel x1={9} y1={14} x2={2.5} y2={14} color={motion} />
                <Travel x1={19} y1={14} x2={25.5} y2={14} color={motion} />
                <Fingertip x={14} y={14} color={finger} />
            </>;
        case 'swipe-two':
            return <>
                <Travel x1={9} y1={14} x2={2.5} y2={14} color={motion} />
                <Travel x1={19} y1={14} x2={25.5} y2={14} color={motion} />
                <Fingertip x={14} y={8.5} color={finger} r={3} />
                <Fingertip x={14} y={19.5} color={finger} r={3} />
            </>;
        case 'pinch':
            return <>
                <Travel x1={8.5} y1={19.5} x2={3} y2={25} color={motion} />
                <Travel x1={19.5} y1={8.5} x2={25} y2={3} color={motion} />
                <Fingertip x={11} y={17} color={finger} r={3} />
                <Fingertip x={17} y={11} color={finger} r={3} />
            </>;
        case 'tap':
            return <>
                <Circle cx={14} cy={14} r={9.5} stroke={motion} strokeWidth={1.4} fill="none" />
                <Fingertip x={14} y={14} color={finger} />
            </>;
        case 'hold':
            return <>
                <Circle cx={14} cy={14} r={9} stroke={motion} strokeWidth={1.4} fill="none" />
                <Circle cx={14} cy={14} r={12.5} stroke={motion} strokeWidth={1.4} fill="none" opacity={0.5} />
                <Fingertip x={14} y={14} color={finger} />
            </>;
        case 'scroll':
            return <>
                <Travel x1={14} y1={9} x2={14} y2={2.5} color={motion} />
                <Travel x1={14} y1={19} x2={14} y2={25.5} color={motion} />
                <Fingertip x={14} y={14} color={finger} />
            </>;
        case 'link':
            return <>
                <Line x1={3} y1={18.5} x2={25} y2={18.5} stroke={motion} strokeWidth={1.6} strokeLinecap="round" />
                <Line x1={3} y1={10.5} x2={17} y2={10.5} stroke={motion} strokeWidth={1.6} strokeLinecap="round" opacity={0.5} />
                <Fingertip x={16} y={18.5} color={finger} r={3.2} />
            </>;
        case 'control':
            return <>
                <Circle cx={18} cy={18} r={6} stroke={motion} strokeWidth={1.6} fill="none" />
                <Circle cx={5} cy={16} r={1.8} fill={motion} />
                <Circle cx={7.5} cy={7.5} r={1.8} fill={motion} />
                <Circle cx={16} cy={5} r={1.8} fill={motion} />
                <Fingertip x={18} y={18} color={finger} r={2.6} />
            </>;
        case 'repeat':
            return <>
                <Rect x={3} y={7} width={22} height={14} rx={3.5} stroke={motion} strokeWidth={1.4} fill="none" />
                <Travel x1={9} y1={14} x2={19.5} y2={14} color={motion} />
                <Fingertip x={9} y={14} color={finger} r={2.8} />
            </>;
        case 'stops':
            return <>
                <Rect x={2} y={8} width={6} height={9} rx={1.6} stroke={motion} strokeWidth={1.4} fill="none" />
                <Rect x={11} y={8} width={6} height={9} rx={1.6} stroke={motion} strokeWidth={1.4} fill="none" opacity={0.35} />
                <Rect x={20} y={8} width={6} height={9} rx={1.6} stroke={motion} strokeWidth={1.4} fill="none" />
                <Path d="M 5 21.5 Q 14 27 23 21.5" stroke={motion} strokeWidth={1.4} strokeLinecap="round" fill="none" />
                <Fingertip x={23} y={21.5} color={finger} r={2.4} />
            </>;
        case 'edge':
            return <>
                <Line x1={2.5} y1={4} x2={2.5} y2={24} stroke={motion} strokeWidth={1.8} strokeLinecap="round" />
                <Travel x1={11} y1={14} x2={25} y2={14} color={motion} />
                <Fingertip x={9} y={14} color={finger} />
            </>;
    }
}

export function GestureGlyph({ gesture, size = SIZE }: { gesture: Gesture; size?: number }) {
    const { theme } = useUnistyles();
    return (
        <Svg width={size} height={size} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
            {marks(gesture, theme.colors.text, theme.colors.textSecondary)}
        </Svg>
    );
}

const TILE_WIDTH = 44;
const TILE_HEIGHT = 32;

/**
 * A choice drawn as itself: the terminal it acts on, dark in both themes the
 * way the terminal is, with the fingers and their travel over it. Off is the
 * same terminal with nothing moving.
 */
export function GestureTile({ gesture }: { gesture: Gesture | 'off' }) {
    const { theme } = useUnistyles();
    const ink = theme.colors.terminalChrome;
    return (
        <Svg width={TILE_WIDTH} height={TILE_HEIGHT} viewBox={`0 0 ${TILE_WIDTH} ${TILE_HEIGHT}`} aria-hidden>
            <Rect x={0.5} y={0.5} width={TILE_WIDTH - 1} height={TILE_HEIGHT - 1} rx={7.5} fill={ink.canvas} stroke={theme.dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.14)'} />
            <Line x1={7} y1={9} x2={27} y2={9} stroke="#d8d8d2" strokeWidth={1.6} strokeLinecap="round" opacity={0.35} />
            <Line x1={7} y1={14} x2={34} y2={14} stroke="#d8d8d2" strokeWidth={1.6} strokeLinecap="round" opacity={0.35} />
            <Line x1={7} y1={19} x2={22} y2={19} stroke="#d8d8d2" strokeWidth={1.6} strokeLinecap="round" opacity={0.35} />
            {gesture !== 'off' && (
                <Svg x={(TILE_WIDTH - 26) / 2} y={(TILE_HEIGHT - 26) / 2} width={26} height={26} viewBox={`0 0 ${SIZE} ${SIZE}`}>
                    {marks(gesture, '#f2f2ee', 'rgba(242, 242, 238, 0.72)')}
                </Svg>
            )}
        </Svg>
    );
}

/**
 * Which agents a swipe stops at, drawn as the Live strip: the agents in a row
 * and the swipe's path along it, stepping over the idle ones or not.
 */
export function StopsTile({ everyAgent }: { everyAgent: boolean }) {
    const { theme } = useUnistyles();
    const ink = theme.colors.terminalChrome;
    const working = theme.colors.status.connected;
    const idle = '#d8d8d2';
    const cards = [true, false, true, false];
    return (
        <Svg width={TILE_WIDTH} height={TILE_HEIGHT} viewBox={`0 0 ${TILE_WIDTH} ${TILE_HEIGHT}`} aria-hidden>
            <Rect x={0.5} y={0.5} width={TILE_WIDTH - 1} height={TILE_HEIGHT - 1} rx={7.5} fill={ink.canvas} stroke={theme.dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.14)'} />
            {cards.map((busy, index) => {
                const stop = busy || everyAgent;
                return (
                    <React.Fragment key={index}>
                        <Rect x={5 + index * 9} y={9} width={7} height={10} rx={1.8} fill={ink.chrome} stroke={stop ? '#d8d8d2' : 'rgba(216, 216, 210, 0.25)'} strokeWidth={1} />
                        <Circle cx={8.5 + index * 9} cy={23.5} r={1.6} fill={busy ? working : idle} opacity={stop ? 1 : 0.3} />
                    </React.Fragment>
                );
            })}
        </Svg>
    );
}
