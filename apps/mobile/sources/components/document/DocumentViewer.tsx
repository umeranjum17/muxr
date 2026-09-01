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
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
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
import { PathBreadcrumb } from '@/components/PathBreadcrumb';
import { CodeCore, HOST_CODE_MAX_CHARS, HOST_CODE_MAX_LINES } from '@/components/code/CodeCore';
import { NavigableDiff } from '@/components/diff/NavigableDiff';
import { fileIcon } from '@/plugins/domain/fileIcon';
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

export const EDGE_INSET = 24;
export const X_ACTIVATE = 14;
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
        <View accessibilityRole="text" accessibilityLabel={label} style={{ minHeight: 22, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {metadata.map((item, index) => (
                <Text key={`${item.value}:${index}`} style={{ color: item.tone === undefined ? theme.colors.textSecondary : toneColor(theme, item.tone), fontSize: 11.5, ...Typography.mono('semiBold') }}>
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
    fontSize: number;
    isNarrow: boolean;
    onHunkOffsets: (offsets: number[]) => void;
    onFileCount: (count: number) => void;
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
    if (props.shownMode === 'diff' && model.diff) {
        return (
            <NavigableDiff
                patch={model.diff}
                fontSize={props.fontSize}
                onHunkOffsets={props.onHunkOffsets}
                onFileCount={props.onFileCount}
                disableFileHeader
                diffStyle={props.isNarrow ? 'unified' : undefined}
                overflow={props.isNarrow ? 'wrap' : 'scroll'}
            />
        );
    }
    if (props.shownMode === 'file' && model.code) {
        return (
            <CodeCore
                code={model.code}
                language={undefined}
                fileName={model.path}
                fontSize={props.isNarrow ? props.fontSize - 1 : props.fontSize}
                lineNumbers={props.isNarrow}
                maxLines={HOST_CODE_MAX_LINES}
                maxChars={HOST_CODE_MAX_CHARS}
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
    const [fontSize, setFontSize] = React.useState(12);
    const [hunkOffsets, setHunkOffsets] = React.useState<number[]>([]);
    const [hunkIndex, setHunkIndex] = React.useState(0);
    const [diffFileCount, setDiffFileCount] = React.useState(1);
    const [slotWidth, setSlotWidth] = React.useState(windowWidth);
    const [pointerCoarse, setPointerCoarse] = React.useState(coarsePointer);
    const hunkIndexRef = React.useRef(0);
    const pinchStart = React.useRef(fontSize);
    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    // RNGH 2.30 types reject AnimatedRef as an external gesture. Same
    // priority as the spec (pinch with scroll, pan blocks scroll) via a
    // Native gesture attached to the scroller.
    const scrollNative = React.useMemo(() => Gesture.Native(), []);
    const reduceMotion = useReducedMotion();
    const translateX = useSharedValue(0);
    const progress = useSharedValue(0);
    const towardNext = useSharedValue(0);
    const startedAt = useSharedValue(0);
    const retired = useSharedValue(0);
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
    const swipeEnabled = isNarrow
        && navigation !== undefined
        && (navigation.previous !== undefined || navigation.next !== undefined)
        && fileCount <= 1
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
        setHunkOffsets([]);
        translateX.set(0);
        progress.set(0);
        towardNext.set(0);
        retired.set(0);
        committed.set(0);
        scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [model?.path, progress, retired, towardNext, translateX, committed, scrollRef]);

    React.useEffect(() => {
        translateX.set(0);
        progress.set(0);
    }, [slotWidth, progress, translateX]);

    React.useEffect(() => {
        if (model?.code === undefined || shownMode !== 'file' || model.highlightLine === undefined || model.highlightLine <= 0) return;
        const lineHeight = Math.round((fontSize - (isNarrow ? 1 : 0)) * 10 / 7);
        const offset = Math.max(0, ((model.highlightLine - 1) * lineHeight) - 40);
        requestAnimationFrame(() => { scrollRef.current?.scrollTo({ y: offset, animated: false }); });
    }, [fontSize, isNarrow, model?.code, model?.highlightLine, scrollRef, shownMode]);

    const jumpHunk = React.useCallback((step: number) => {
        if (hunkOffsets.length === 0) return;
        const next = Math.min(hunkOffsets.length - 1, Math.max(0, hunkIndexRef.current + step));
        hunkIndexRef.current = next;
        setHunkIndex(next);
        scrollRef.current?.scrollTo({ y: Math.max(0, hunkOffsets[next]! + 16 - 8), animated: reduceMotion !== true });
    }, [hunkOffsets, reduceMotion, scrollRef]);

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
            if ((event.key === 'n' || event.key === 'p') && hunkOffsets.length > 1) {
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
    }, [hunkOffsets.length, jumpHunk, navigation, onNavigate, router]);

    const commitNavigation = React.useCallback((path: string) => {
        hapticsLight();
        onNavigateRef.current?.(path);
    }, []);

    const pinch = React.useMemo(
        () => Gesture.Pinch()
            .onBegin(() => { pinchStart.current = fontSize; })
            .onEnd((event) => { setFontSize(Math.round(Math.min(28, Math.max(8, pinchStart.current * event.scale)))); })
            .runOnJS(true)
            .simultaneousWithExternalGesture(scrollNative),
        [fontSize, scrollNative],
    );

    const pan = React.useMemo(
        () => Gesture.Pan()
            .enabled(swipeEnabled)
            .hitSlop({ horizontal: -EDGE_INSET })
            .activeOffsetX([-X_ACTIVATE, X_ACTIVATE])
            .failOffsetY([-Y_FAIL, Y_FAIL])
            .minPointers(1)
            .maxPointers(1)
            .blocksExternalGesture(scrollNative)
            .onTouchesDown((event, manager) => {
                const touch = event.allTouches[0];
                if (touch !== undefined && (touch.x < EDGE_INSET || touch.x > widthSV.value - EDGE_INSET)) manager.fail();
                startedAt.value = Date.now();
                retired.value = 0;
                committed.value = 0;
            })
            .onStart((event) => {
                if (Date.now() - startedAt.value > INTENT_WINDOW) {
                    retired.value = 1;
                    translateX.set(0);
                    progress.set(0);
                    return;
                }
                towardNext.value = event.translationX * forwardSV.value < 0 ? 1 : 0;
            })
            .onUpdate((event) => {
                if (retired.value === 1 || committed.value === 1) return;
                if (Date.now() - startedAt.value > INTENT_WINDOW && Math.abs(event.translationX) < X_ACTIVATE) {
                    retired.value = 1;
                    translateX.set(0);
                    progress.set(0);
                    return;
                }
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
                if (retired.value === 1 || path === '' || !(distanceOk || velocityOk)) {
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
            }),
        [commitNavigation, scrollNative, swipeEnabled],
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
    };

    const breadcrumbSegments = (model?.path ?? '').split('/').filter(Boolean).map((label, index, segments) => ({
        label: index === segments.length - 1 ? `${label}${model?.lineSuffix ?? ''}` : label,
        ...(index === segments.length - 1 && model !== null ? { icon: fileIcon(model.fileName).name } : {}),
    }));

    return (
        <View style={[styles.container, { backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }) }]}>
            <PathBreadcrumb
                segments={breadcrumbSegments.length === 0 ? [{ label: model?.fileName || ' ' }] : breadcrumbSegments}
                fullPath={model?.path ?? ''}
                {...(model?.metadata === undefined ? {} : { trailing: <MetadataChips metadata={model.metadata} /> })}
            />
            <View
                style={{ flex: 1 }}
                onLayout={(event: LayoutChangeEvent) => setSlotWidth(event.nativeEvent.layout.width)}
            >
                <GestureDetector gesture={composed}>
                    <Animated.View style={[{ flex: 1 }, contentStyle]}>
                        <GestureDetector gesture={scrollNative}>
                            <Animated.ScrollView
                                ref={scrollRef}
                                style={{ flex: 1 }}
                                contentContainerStyle={{ padding: 16, paddingBottom: 48 + insets.bottom + 16, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', flexGrow: 1 }}
                                showsVerticalScrollIndicator
                            >
                                <DocumentBody
                                    document={model}
                                    loading={loading}
                                    error={error}
                                    shownMode={shownMode}
                                    fontSize={fontSize}
                                    isNarrow={isNarrow}
                                    onHunkOffsets={setHunkOffsets}
                                    onFileCount={setDiffFileCount}
                                />
                            </Animated.ScrollView>
                        </GestureDetector>
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
                hunkCount={hunkOffsets.length}
                hunkIndex={hunkIndex}
                onModeChange={setDisplayMode}
                onJumpHunk={jumpHunk}
                documentLabel={model?.fileName ?? t('files.file')}
                accessibilityActions={[
                    { name: 'previousDocument', label: t('files.previousDocument') },
                    { name: 'nextDocument', label: t('files.nextDocument') },
                    { name: 'previousChange', label: t('files.previousChange') },
                    { name: 'nextChange', label: t('files.nextChange') },
                    { name: 'toggleView', label: t('files.toggleFileAndDiff') },
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
