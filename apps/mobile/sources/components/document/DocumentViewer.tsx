import * as React from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    I18nManager,
    Platform,
    View,
    useWindowDimensions,
    type AccessibilityActionEvent,
    type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, {
    Easing,
    useAnimatedRef,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withSpring,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import type { CodeContentPadding } from '@/components/code/CodeCore';
import { CodeSurface } from '@/components/document/CodeSurface';
import { PanelHeader } from '@/components/document/PanelHeader';
import { surfaceModel } from '@/components/document/surfaceModel';
import { useMonoCharWidth } from '@/components/code/monoMetrics';
import { syntaxLanguage } from '@/components/code/syntaxHighlighting';
import { toneColor } from '@/plugins/domain/pluginTone';
import { type PluginScreenTone } from '@muxr/contract';
import { hapticsLight } from '@/components/haptics';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import {
    DocumentNavigatorBar,
    type DocumentDisplayMode,
    type DocumentViewerNavigation,
} from './DocumentViewerInteraction';

export type DocumentMetadataItem = {
    label?: string;
    value: string;
    tone?: PluginScreenTone;
};

/**
 * The reading surface's zoom ladder, identical to the terminal pane's
 * `FONT_STEPS` (TerminalView.tsx:51) so one tap means one thing in both
 * panes. Worth hoisting into `codeLayout` when the terminal is not being
 * edited by someone else.
 */
export const FONT_STEPS = [8, 10, 12, 14, 17, 20] as const;

export const EDGE_INSET = 24;
export const X_ACTIVATE = 16;
export const Y_FAIL = 12;
export const INTENT_WINDOW = 400;
export const COMMIT_DISTANCE_MIN = 64;
export const COMMIT_DISTANCE_RATIO = 0.22;
export const COMMIT_VELOCITY = 450;
export const COMMIT_VELOCITY_TRAVEL = 24;
export const FOLLOW_GAIN_BELOW = 0.9;
export const FOLLOW_GAIN_ABOVE = 0.35;
export const MAX_TRAVEL_RATIO = 0.5;
export const BOUNDARY_GAIN = 0.25;
export const BOUNDARY_CAP = 32;
export const COMMIT_EXIT_RATIO = 0.3;
export const COMMIT_EXIT_MS = 110;
export const CANCEL_RETURN_MS = 300;
export const CANCEL_DAMPING_RATIO = 0.9;
const STATE_CANCELLED = 3;

export interface DocumentModel {
    path: string;
    fileName: string;
    lineSuffix?: string;
    highlightLine?: number;
    code?: string;
    diff?: string;
    binary?: boolean;
    empty?: boolean;
    deleted?: boolean;
    metadata?: DocumentMetadataItem[];
    navigation?: DocumentViewerNavigation;
}

function basename(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.slice(slash + 1);
}

function coarsePointer(): boolean {
    if (Platform.OS !== 'web') return true;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(pointer: coarse)').matches;
}

function MetadataChips({ metadata }: { metadata: DocumentMetadataItem[] }) {
    const { theme } = useUnistyles();
    if (metadata.length === 0) return null;
    const label = metadata.map((item) => `${item.label === undefined ? '' : `${item.label} `}${item.value}`).join(', ');
    return (
        <View accessibilityRole="text" accessibilityLabel={label} style={{ minHeight: 20, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.code.hairline, backgroundColor: theme.colors.code.pressed, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {metadata.map((item, index) => (
                <Text key={`${item.value}:${index}`} style={{ color: item.tone === undefined ? theme.colors.code.dim : toneColor(theme, item.tone), fontSize: 11.5, ...Typography.mono('semiBold') }}>
                    {item.label === undefined ? item.value : `${item.label} ${item.value}`}
                </Text>
            ))}
        </View>
    );
}

function DocumentBody(props: {
    document: DocumentModel | null;
    loading: boolean;
    error: string | null;
    shownMode: DocumentDisplayMode;
    /** Pinch override; undefined lets each viewer derive its size from the width. */
    fontSize?: number;
    isNarrow: boolean;
    wrap: boolean;
    contentWidth: number;
    contentPadding: CodeContentPadding;
    surfaceRef: React.MutableRefObject<{ jumpToRow: (row: number) => void } | null>;
    onHunkIndices: (indices: number[]) => void;
    onFileCount: (count: number) => void;
    onDerivedFontSize: (size: number) => void;
    railNative?: NativeGesture;
}) {
    const { theme } = useUnistyles();
    const model = props.document;
    if (props.loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ marginTop: 16, fontSize: 16, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('files.loadingFile', { fileName: model?.fileName ?? '' })}
                </Text>
            </View>
        );
    }
    if (props.error !== null) {
        return (
            <View style={[styles.centered, { padding: 20 }]}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', color: theme.colors.textDestructive, marginBottom: 8, ...Typography.default('semiBold') }}>{t('common.error')}</Text>
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', ...Typography.default() }}>{props.error}</Text>
            </View>
        );
    }
    if (model === null) return null;
    if (model.binary === true && (props.shownMode === 'file' || !model.diff)) {
        return (
            <View style={[styles.centered, { padding: 20 }]}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', color: theme.colors.textSecondary, marginBottom: 8, ...Typography.default('semiBold') }}>{t('files.binaryFile')}</Text>
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', ...Typography.default() }}>{t('files.cannotDisplayBinary')}</Text>
                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 8, ...Typography.default() }}>{model.fileName}</Text>
            </View>
        );
    }
    if (model.diff !== undefined || model.code !== undefined) {
        return (
            <ReadingBody
                model={model}
                shownMode={props.shownMode}
                isNarrow={props.isNarrow}
                contentWidth={props.contentWidth}
                wrap={props.wrap}
                contentPadding={props.contentPadding}
                surfaceRef={props.surfaceRef}
                onHunkIndices={props.onHunkIndices}
                onDerivedFontSize={props.onDerivedFontSize}
                {...(props.fontSize === undefined ? {} : { fontSize: props.fontSize })}
            />
        );
    }
    if (props.shownMode === 'file' && model.deleted === true) {
        return <Text style={{ fontSize: 16, color: theme.colors.textSecondary, fontStyle: 'italic', ...Typography.default() }}>{t('files.fileDeleted')}</Text>;
    }
    if (props.shownMode === 'file' && model.empty === true) {
        return <Text style={{ fontSize: 16, color: theme.colors.textSecondary, fontStyle: 'italic', ...Typography.default() }}>{t('files.fileEmpty')}</Text>;
    }
    if (!model.diff && !model.code) {
        return <Text style={{ fontSize: 16, color: theme.colors.textSecondary, fontStyle: 'italic', ...Typography.default() }}>{t('files.noChanges')}</Text>;
    }
    return null;
}

/**
 * The reading surface: one gutter-less column with a scope pin, a scrubber and
 * pills where the patch skipped content. A file and a diff are the same
 * surface; only the provenance of the rows differs.
 */
function ReadingBody(props: {
    model: DocumentModel;
    shownMode: DocumentDisplayMode;
    isNarrow: boolean;
    contentWidth: number;
    contentPadding: CodeContentPadding;
    fontSize?: number;
    wrap: boolean;
    surfaceRef: React.MutableRefObject<{ jumpToRow: (row: number) => void } | null>;
    onHunkIndices: (indices: number[]) => void;
    onDerivedFontSize: (size: number) => void;
}) {
    const { theme } = useUnistyles();
    const size = props.fontSize ?? (props.isNarrow ? 12 : 14);
    const { charWidth, probe } = useMonoCharWidth([size, size - 1]);
    const built = React.useMemo(
        () => surfaceModel({
            showChanges: props.shownMode === 'diff',
            ...(props.model.code === undefined ? {} : { code: props.model.code }),
            ...(props.model.diff === undefined ? {} : { diff: props.model.diff }),
        }),
        [props.model.code, props.model.diff, props.shownMode],
    );
    const onDerivedFontSize = props.onDerivedFontSize;
    React.useEffect(() => { onDerivedFontSize(size); }, [onDerivedFontSize, size]);
    const onHunkIndices = props.onHunkIndices;
    React.useEffect(() => { onHunkIndices(built?.hunkRows ?? []); }, [built, onHunkIndices]);
    if (built === null) {
        return <Text style={{ fontSize: 16, color: theme.colors.textSecondary, fontStyle: 'italic', ...Typography.default() }}>{t('files.noChanges')}</Text>;
    }
    const added = built.rows.reduce((count, row) => row.prefix === '+' ? count + 1 : count, 0);
    const removed = built.rows.reduce((count, row) => row.prefix === '-' ? count + 1 : count, 0);
    return (
        <View style={{ flex: 1 }}>
            <CodeSurface
                rows={built.rows}
                hunkRows={built.hunkRows}
                foldUnchanged={built.foldUnchanged}
                separators={built.separators}
                contentWidth={props.contentWidth}
                charWidth={charWidth(size)}
                fontSize={size}
                isNarrow={props.isNarrow}
                wrap={props.wrap}
                paddingTop={props.contentPadding.top}
                paddingBottom={props.contentPadding.bottom}
                surfaceRef={props.surfaceRef}
                language={syntaxLanguage(undefined, props.model.path)}
                header={<PanelHeader
                    {...(props.model.path === undefined ? {} : { path: props.model.path })}
                    {...(syntaxLanguage(undefined, props.model.path) === undefined ? {} : { language: syntaxLanguage(undefined, props.model.path) })}
                    added={added}
                    removed={removed}
                    {...(props.model.metadata === undefined ? {} : { trailing: <MetadataChips metadata={props.model.metadata} /> })}
                />}
                {...(props.model.highlightLine === undefined ? {} : { highlightLine: props.model.highlightLine })}
            />
            {probe}
        </View>
    );
}

function SwipeAffordance(props: {
    progress: SharedValue<number>;
    towardNext: SharedValue<number>;
    reduceMotion: boolean;
    nextLabel: string;
    previousLabel: string;
    hasNext: boolean;
    hasPrevious: boolean;
    forward: number;
}) {
    const { theme } = useUnistyles();
    const nextIncomingRight = props.forward === 1;
    const nextStyle = useAnimatedStyle(() => {
        const show = props.towardNext.value === 1 && props.progress.value > 0;
        const ready = props.progress.value >= 1;
        const slide = props.reduceMotion ? 0 : (1 - props.progress.value) * 24;
        return {
            opacity: show ? Math.min(1, props.progress.value * 1.4) : 0,
            transform: [{ translateX: (nextIncomingRight ? 1 : -1) * slide }],
            borderColor: ready ? theme.colors.accent : theme.colors.divider,
        };
    });
    const previousStyle = useAnimatedStyle(() => {
        const show = props.towardNext.value === 0 && props.progress.value > 0;
        const ready = props.progress.value >= 1;
        const slide = props.reduceMotion ? 0 : (1 - props.progress.value) * 24;
        return {
            opacity: show ? Math.min(1, props.progress.value * 1.4) : 0,
            transform: [{ translateX: (nextIncomingRight ? -1 : 1) * slide }],
            borderColor: ready ? theme.colors.accent : theme.colors.divider,
        };
    });
    const nextColor = useAnimatedStyle(() => ({
        color: props.progress.value >= 1 ? theme.colors.accent : theme.colors.textSecondary,
    }));
    const previousColor = useAnimatedStyle(() => ({
        color: props.progress.value >= 1 ? theme.colors.accent : theme.colors.textSecondary,
    }));
    const nextText = useAnimatedStyle(() => ({
        color: props.progress.value >= 1 ? theme.colors.text : theme.colors.textSecondary,
    }));
    const previousText = useAnimatedStyle(() => ({
        color: props.progress.value >= 1 ? theme.colors.text : theme.colors.textSecondary,
    }));
    const pill = (side: 'left' | 'right', label: string, chevron: string, style: object, iconStyle: object, textStyle: object) => (
        <Animated.View
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            style={[styles.pill, { top: '42%', [side]: 16, backgroundColor: theme.colors.surfaceHigh }, style]}
        >
            <Animated.Text style={[{ fontSize: 14, ...Typography.mono() }, iconStyle]}>{chevron}</Animated.Text>
            <Animated.Text numberOfLines={1} style={[{ maxWidth: '100%', fontSize: 11.5, ...Typography.mono() }, textStyle]}>{label}</Animated.Text>
        </Animated.View>
    );
    return (
        <>
            {props.hasNext && pill(nextIncomingRight ? 'right' : 'left', props.nextLabel, nextIncomingRight ? '›' : '‹', nextStyle, nextColor, nextText)}
            {props.hasPrevious && pill(nextIncomingRight ? 'left' : 'right', props.previousLabel, nextIncomingRight ? '‹' : '›', previousStyle, previousColor, previousText)}
        </>
    );
}

function EdgeRail(props: {
    progress: SharedValue<number>;
    towardNext: SharedValue<number>;
    hasNext: boolean;
    hasPrevious: boolean;
    forward: number;
}) {
    const { theme } = useUnistyles();
    const nextIncomingRight = props.forward === 1;
    const nextStyle = useAnimatedStyle(() => ({
        opacity: props.towardNext.value === 1 ? props.progress.value * 0.6 : 0,
    }));
    const previousStyle = useAnimatedStyle(() => ({
        opacity: props.towardNext.value === 0 ? props.progress.value * 0.6 : 0,
    }));
    const rail = (side: 'left' | 'right', style: object, visible: boolean) => visible && (
        <Animated.View
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            style={[styles.rail, { [side]: 0, backgroundColor: theme.colors.accent }, style]}
        />
    );
    return (
        <>
            {rail(nextIncomingRight ? 'right' : 'left', nextStyle, props.hasNext)}
            {rail(nextIncomingRight ? 'left' : 'right', previousStyle, props.hasPrevious)}
        </>
    );
}

export function DocumentViewer(props: {
    document: DocumentModel | null;
    loading: boolean;
    error: string | null;
    onNavigate?: (path: string) => void;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { document: model, loading, error, onNavigate } = props;
    const { width: windowWidth } = useWindowDimensions();
    const isNarrow = windowWidth < 700;
    const [displayMode, setDisplayMode] = React.useState<DocumentDisplayMode>('diff');
    // Zoom is the terminal pane's ladder, not a free float: `FONT_STEPS` here
    // mirrors TerminalView.tsx:51 so a tap means the same thing in both panes.
    // `undefined` means the derived size is still in charge.
    const [stepIndex, setStepIndex] = React.useState<number>();
    const [derivedSize, setDerivedSize] = React.useState(12);
    // Off by default: no ladder step makes a wide line fit a phone, so the
    // surface pans instead, which is what a horizontal drag already means
    // in the terminal pane.
    const [wrapCode, setWrapCode] = React.useState(false);
    const [hunkIndices, setHunkIndices] = React.useState<number[]>([]);
    const [hunkIndex, setHunkIndex] = React.useState(0);
    const [diffFileCount, setDiffFileCount] = React.useState(1);
    const [slotWidth, setSlotWidth] = React.useState(windowWidth);
    const [pointerCoarse, setPointerCoarse] = React.useState(coarsePointer);
    const hunkIndexRef = React.useRef(0);
    const pinchStart = React.useRef(12);
    const surfaceRef = React.useRef<{ jumpToRow: (row: number) => void } | null>(null);
    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    // RNGH 2.30 types reject AnimatedRef as an external gesture. Same
    // priority as the spec (pinch with scroll, pan blocks scroll) via a
    // Native gesture attached to the scroller.
    const scrollNative = React.useMemo(() => Gesture.Native(), []);
    const railNative = React.useMemo(() => Gesture.Native(), []);
    const reduceMotion = useReducedMotion();
    const translateX = useSharedValue(0);
    const progress = useSharedValue(0);
    const towardNext = useSharedValue(0);
    const startedAt = useSharedValue(0);
    const startX = useSharedValue(0);
    const committed = useSharedValue(0);
    const widthSV = useSharedValue(windowWidth);
    const forwardSV = useSharedValue(I18nManager.isRTL ? -1 : 1);
    const hasNextSV = useSharedValue(0);
    const hasPreviousSV = useSharedValue(0);
    const nextPathSV = useSharedValue('');
    const previousPathSV = useSharedValue('');
    const reduceSV = useSharedValue(reduceMotion ? 1 : 0);
    const onNavigateRef = React.useRef(onNavigate);
    onNavigateRef.current = onNavigate;

    const navigation = model?.navigation;
    const shownMode: DocumentDisplayMode = displayMode === 'diff' && !model?.diff ? 'file' : displayMode;
    const fileCount = shownMode === 'diff' && model?.diff ? diffFileCount : 1;
    // The x-axis has one meaning at a time. Unwrapped, it pans the code, the
    // same thing a horizontal drag does in the terminal pane, so the
    // file-swipe stands down and the bar's arrows carry navigation. Put the
    // surface back into wrapping and the swipe returns, because nothing else
    // wants the axis then.
    const swipeEnabled = isNarrow
        && wrapCode
        && navigation !== undefined
        && (navigation.previous !== undefined || navigation.next !== undefined)
        && pointerCoarse;
    const forward = I18nManager.isRTL ? -1 : 1;

    React.useEffect(() => { widthSV.set(slotWidth); }, [slotWidth, widthSV]);
    React.useEffect(() => { reduceSV.set(reduceMotion ? 1 : 0); }, [reduceMotion, reduceSV]);
    React.useEffect(() => { forwardSV.set(forward); }, [forward, forwardSV]);
    React.useEffect(() => {
        hasNextSV.set(navigation?.next === undefined ? 0 : 1);
        hasPreviousSV.set(navigation?.previous === undefined ? 0 : 1);
        nextPathSV.set(navigation?.next?.path ?? '');
        previousPathSV.set(navigation?.previous?.path ?? '');
    }, [hasNextSV, hasPreviousSV, navigation, nextPathSV, previousPathSV]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const query = window.matchMedia('(pointer: coarse)');
        const sync = () => setPointerCoarse(query.matches);
        sync();
        query.addEventListener('change', sync);
        return () => query.removeEventListener('change', sync);
    }, []);

    React.useEffect(() => {
        hunkIndexRef.current = 0;
        setHunkIndex(0);
        setHunkIndices([]);
        // The chosen ladder step survives a file change, the way the terminal
        // pane keeps its size when its content changes. Reset zoom is how you
        // get back to the derived size.
        translateX.set(0);
        progress.set(0);
        towardNext.set(0);
        committed.set(0);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [model?.path, progress, towardNext, translateX, committed, scrollRef]);

    React.useEffect(() => {
        translateX.set(0);
        progress.set(0);
    }, [slotWidth, progress, translateX]);

    const jumpHunk = React.useCallback((step: number) => {
        if (hunkIndices.length === 0) return;
        const next = Math.min(hunkIndices.length - 1, Math.max(0, hunkIndexRef.current + step));
        hunkIndexRef.current = next;
        setHunkIndex(next);
        // The surface owns its own scroller now, so the bar asks it to move
        // rather than reaching into a list it no longer mounts.
        surfaceRef.current?.jumpToRow(hunkIndices[next]!);
    }, [hunkIndices]);

    React.useEffect(() => {
        if (model?.path === undefined || navigation === undefined) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
            if (!enabled) return;
            timer = setTimeout(() => {
                AccessibilityInfo.announceForAccessibility(`${model.fileName}, ${t('files.filePosition', { current: navigation.index + 1, total: navigation.total })}`);
            }, 250);
        });
        return () => { if (timer !== undefined) clearTimeout(timer); };
    }, [model?.fileName, model?.path, navigation]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const onKey = (event: KeyboardEvent) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
            if (event.key === 'Escape') {
                router.back();
                return;
            }
            if (event.key === 'm') {
                setDisplayMode((current) => current === 'diff' ? 'file' : 'diff');
                return;
            }
            if ((event.key === 'n' || event.key === 'p') && hunkIndices.length > 1) {
                jumpHunk(event.key === 'n' ? 1 : -1);
                return;
            }
            const rtl = I18nManager.isRTL;
            const nextDoc = event.key === ']' || (event.key === 'ArrowRight' && !rtl) || (event.key === 'ArrowLeft' && rtl);
            const prevDoc = event.key === '[' || (event.key === 'ArrowLeft' && !rtl) || (event.key === 'ArrowRight' && rtl);
            if (nextDoc && navigation?.next) onNavigate?.(navigation.next.path);
            if (prevDoc && navigation?.previous) onNavigate?.(navigation.previous.path);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [hunkIndices.length, jumpHunk, navigation, onNavigate, router]);

    const commitNavigation = React.useCallback((path: string) => {
        hapticsLight();
        onNavigateRef.current?.(path);
    }, []);

    const effectiveSize = stepIndex === undefined ? derivedSize : (FONT_STEPS[stepIndex] ?? derivedSize);
    const nearestStep = React.useCallback((size: number) => {
        let best = 0;
        for (let index = 1; index < FONT_STEPS.length; index += 1) {
            if (Math.abs(FONT_STEPS[index]! - size) < Math.abs(FONT_STEPS[best]! - size)) best = index;
        }
        return best;
    }, []);
    const zoom = React.useCallback((direction: 1 | -1) => {
        hapticsLight();
        setStepIndex((current) => {
            const from = current ?? nearestStep(derivedSize);
            return Math.max(0, Math.min(FONT_STEPS.length - 1, from + direction));
        });
    }, [derivedSize, nearestStep]);
    const resetZoom = React.useCallback(() => { hapticsLight(); setStepIndex(undefined); }, []);
    // Each ladder step applies the moment the pinch crosses it, with a real
    // re-layout. Nothing is scaled: a surface that stretches pixels it has
    // not laid out lies about where its content is, and the settle on
    // release reads as a bug rather than as arriving.
    const pinch = React.useMemo(
        () => Gesture.Pinch()
            .onBegin(() => { pinchStart.current = effectiveSize; })
            .onUpdate((event) => {
                const target = nearestStep(pinchStart.current * event.scale);
                setStepIndex((current) => current === target ? current : target);
            })
            .runOnJS(true)
            .simultaneousWithExternalGesture(scrollNative),
        [effectiveSize, nearestStep, scrollNative],
    );

    const pan = React.useMemo(
        () => {
            const gesture = Gesture.Pan()
                .enabled(swipeEnabled)
                .hitSlop({ horizontal: -EDGE_INSET })
                .activeOffsetX([-X_ACTIVATE, X_ACTIVATE])
                .failOffsetY([-Y_FAIL, Y_FAIL])
                .minPointers(1)
                .maxPointers(1)
                .blocksExternalGesture(scrollNative);
            if (fileCount > 1) gesture.requireExternalGestureToFail(railNative);
            return gesture
            .onTouchesDown((event, manager) => {
                const touch = event.allTouches[0];
                if (touch !== undefined && (touch.x < EDGE_INSET || touch.x > widthSV.value - EDGE_INSET)) manager.fail();
                startedAt.value = Date.now();
                startX.value = touch?.x ?? 0;
                committed.value = 0;
            })
            .onTouchesMove((event, manager) => {
                const touch = event.allTouches[0];
                if (touch === undefined) return;
                const dx = touch.x - startX.value;
                if (Date.now() - startedAt.value > INTENT_WINDOW && Math.abs(dx) < X_ACTIVATE) manager.fail();
            })
            .onStart((event) => {
                towardNext.value = event.translationX * forwardSV.value < 0 ? 1 : 0;
            })
            .onUpdate((event) => {
                if (committed.value === 1) return;
                const dx = event.translationX;
                const goingNext = dx * forwardSV.value < 0;
                towardNext.value = goingNext ? 1 : 0;
                const hasTarget = goingNext ? hasNextSV.value : hasPreviousSV.value;
                if (hasTarget === 0) {
                    const rubber = Math.max(-BOUNDARY_CAP, Math.min(BOUNDARY_CAP, dx * BOUNDARY_GAIN));
                    translateX.set(reduceSV.value === 1 ? 0 : rubber);
                    progress.set(0);
                    return;
                }
                const distance = Math.max(COMMIT_DISTANCE_MIN, COMMIT_DISTANCE_RATIO * widthSV.value);
                const gain = Math.abs(dx) < distance ? FOLLOW_GAIN_BELOW : FOLLOW_GAIN_ABOVE;
                const maxTravel = MAX_TRAVEL_RATIO * widthSV.value;
                const effective = Math.max(-maxTravel, Math.min(maxTravel, dx * gain));
                translateX.set(reduceSV.value === 1 ? 0 : effective);
                progress.set(Math.min(1, Math.abs(effective) / distance));
            })
            .onEnd((event) => {
                if (committed.value === 1) return;
                const dx = event.translationX;
                const goingNext = dx * forwardSV.value < 0;
                const path = goingNext ? nextPathSV.value : previousPathSV.value;
                const distance = Math.max(COMMIT_DISTANCE_MIN, COMMIT_DISTANCE_RATIO * widthSV.value);
                const distanceOk = Math.abs(dx) >= distance;
                const velocityOk = Math.abs(event.velocityX) >= COMMIT_VELOCITY && Math.abs(dx) >= COMMIT_VELOCITY_TRAVEL && event.velocityX * dx > 0;
                if (path === '' || !(distanceOk || velocityOk)) {
                    translateX.set(withSpring(0, { duration: CANCEL_RETURN_MS, dampingRatio: CANCEL_DAMPING_RATIO, overshootClamping: true, velocity: event.velocityX }));
                    progress.set(0);
                    return;
                }
                committed.value = 1;
                scheduleOnRN(commitNavigation, path);
                if (reduceSV.value === 1) {
                    translateX.set(0);
                    progress.set(0);
                    return;
                }
                const signed = (goingNext ? -1 : 1) * forwardSV.value * COMMIT_EXIT_RATIO * widthSV.value;
                translateX.set(withTiming(signed, { duration: COMMIT_EXIT_MS, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
            })
            .onFinalize((event) => {
                if (committed.value === 1) return;
                if (event.state !== STATE_CANCELLED) return;
                translateX.set(withSpring(0, { duration: CANCEL_RETURN_MS, dampingRatio: CANCEL_DAMPING_RATIO, overshootClamping: true, velocity: 0 }));
                progress.set(0);
            });
        },
        [commitNavigation, fileCount, railNative, scrollNative, swipeEnabled],
    );

    const composed = React.useMemo(() => Gesture.Simultaneous(pinch, pan), [pinch, pan]);
    const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

    const onAccessibilityAction = (event: AccessibilityActionEvent) => {
        const name = event.nativeEvent.actionName;
        if (name === 'previousDocument' && navigation?.previous) onNavigate?.(navigation.previous.path);
        if (name === 'nextDocument' && navigation?.next) onNavigate?.(navigation.next.path);
        if (name === 'previousChange') jumpHunk(-1);
        if (name === 'nextChange') jumpHunk(1);
        if (name === 'toggleView') setDisplayMode((current) => current === 'diff' ? 'file' : 'diff');
        if (name === 'toggleWrap') setWrapCode((current) => !current);
    };

    // The panel supplies its own 12 dp side inset, so the page adds none.
    const inset = 0;
    const contentPadding: CodeContentPadding = { horizontal: inset, top: 8, bottom: 52 + insets.bottom + 24 };
    const virtualized = shownMode === 'diff' ? Boolean(model?.diff) : Boolean(model?.code);
    const body = (
        <DocumentBody
            document={model}
            loading={loading}
            error={error}
            shownMode={shownMode}
            isNarrow={isNarrow}
            wrap={wrapCode}
            contentWidth={Math.min(slotWidth, layout.maxWidth) - inset * 2}
            contentPadding={contentPadding}
            surfaceRef={surfaceRef}
            onHunkIndices={setHunkIndices}
            onFileCount={setDiffFileCount}
            onDerivedFontSize={setDerivedSize}
            railNative={railNative}
            {...(stepIndex === undefined ? {} : { fontSize: effectiveSize })}
        />
    );

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.groupped.background }]}>
            {/* The breadcrumb is gone: the navigation bar already names the
                file, and the panel's own header carries the directory, the
                language and the change counts in 40 dp instead of 44. */}
            <View
                style={{ flex: 1 }}
                onLayout={(event: LayoutChangeEvent) => setSlotWidth(event.nativeEvent.layout.width)}
            >
                <GestureDetector gesture={composed}>
                    <Animated.View style={[{ flex: 1 }, contentStyle]}>
                        {/* `Gesture.Native` must sit on an actual scroller.
                            Wrapping the virtualized branch's plain View made
                            the handler swallow the drag before the list saw
                            it, so the panel would not scroll at all. */}
                        {virtualized ? (
                            <View style={{ flex: 1, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>{body}</View>
                        ) : (
                            <GestureDetector gesture={scrollNative}>
                                <Animated.ScrollView
                                    ref={scrollRef}
                                    style={{ flex: 1 }}
                                    contentContainerStyle={{ padding: inset, paddingBottom: contentPadding.bottom, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', flexGrow: 1 }}
                                    showsVerticalScrollIndicator
                                >
                                    {body}
                                </Animated.ScrollView>
                            </GestureDetector>
                        )}
                    </Animated.View>
                </GestureDetector>
                {swipeEnabled && (
                    <>
                        <SwipeAffordance
                            progress={progress}
                            towardNext={towardNext}
                            reduceMotion={reduceMotion === true}
                            nextLabel={navigation?.next?.title ?? basename(navigation?.next?.path ?? '')}
                            previousLabel={navigation?.previous?.title ?? basename(navigation?.previous?.path ?? '')}
                            hasNext={navigation?.next !== undefined}
                            hasPrevious={navigation?.previous !== undefined}
                            forward={forward}
                        />
                        <EdgeRail
                            progress={progress}
                            towardNext={towardNext}
                            hasNext={navigation?.next !== undefined}
                            hasPrevious={navigation?.previous !== undefined}
                            forward={forward}
                        />
                    </>
                )}
            </View>
            <DocumentNavigatorBar
                mode={shownMode}
                hasDiff={Boolean(model?.diff)}
                hunkCount={hunkIndices.length}
                hunkIndex={hunkIndex}
                onModeChange={setDisplayMode}
                onJumpHunk={jumpHunk}
                wrap={wrapCode}
                onWrapChange={setWrapCode}
                onZoom={zoom}
                onResetZoom={resetZoom}
                atMinZoom={(stepIndex ?? nearestStep(derivedSize)) <= 0}
                atMaxZoom={(stepIndex ?? nearestStep(derivedSize)) >= FONT_STEPS.length - 1}
                zoomed={stepIndex !== undefined}
                documentLabel={model?.fileName ?? t('files.file')}
                accessibilityActions={[
                    { name: 'previousDocument', label: t('files.previousDocument') },
                    { name: 'nextDocument', label: t('files.nextDocument') },
                    { name: 'previousChange', label: t('files.previousChange') },
                    { name: 'nextChange', label: t('files.nextChange') },
                    { name: 'toggleView', label: t('files.toggleFileAndDiff') },
                    { name: 'toggleWrap', label: t('files.wrapLines') },
                ]}
                onAccessibilityAction={onAccessibilityAction}
                {...(navigation === undefined ? {} : { navigation })}
                {...(onNavigate === undefined ? {} : { onNavigateFile: onNavigate })}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 180,
    },
    pill: {
        position: 'absolute',
        height: 28,
        borderRadius: 14,
        paddingHorizontal: 10,
        maxWidth: '60%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: StyleSheet.hairlineWidth,
    },
    rail: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 3,
    },
});
