import * as React from 'react';
import { Platform, Text, View, type ListRenderItemInfo } from 'react-native';
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector, type PanGestureHandlerEventPayload, type GestureUpdateEvent } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, syntaxLanguage, type SyntaxSpan } from '@/components/code/syntaxHighlighting';
import {
    GAP,
    RIGHT_INSET,
    columnsFor,
    deriveFontSize,
    expandTabs,
    fileGutterWidth,
    layoutLines,
    lineHeightFor,
    prefixSums,
    sliceSpans,
    type LineLayout,
} from '@/components/code/codeLayout';
import { useMonoCharWidth } from '@/components/code/monoMetrics';
import { pagePalette } from '@/components/code/syntaxPalette';
import { ui, withAlpha } from '@/components/ui';
import { PathBreadcrumb } from '@/components/PathBreadcrumb';
import { fileIcon } from '@/plugins/domain/fileIcon';

export const PLUGIN_CODE_MAX_LINES = 600;
export const PLUGIN_CODE_MAX_CHARS = 64 * 1024;
export const HOST_CODE_MAX_LINES = 2000;
export const HOST_CODE_MAX_CHARS = 256 * 1024;

/** Reanimated's list, so the fade opacity can follow scroll without a JS round trip. */
const RIGHT_FADE = 28;
const LEFT_FADE = 16;

export interface CodeContentPadding {
    horizontal: number;
    top: number;
    bottom: number;
}

function EdgeFades(props: {
    scrollX: SharedValue<number>;
    overflow: SharedValue<number>;
    left: number;
    background: string;
}) {
    const rightStyle = useAnimatedStyle(() => ({
        opacity: Math.min(1, Math.max(0, (props.overflow.value - props.scrollX.value) / RIGHT_FADE)),
    }));
    const leftStyle = useAnimatedStyle(() => ({
        opacity: Math.min(1, Math.max(0, props.scrollX.value / LEFT_FADE)),
    }));
    const transparent = withAlpha(props.background, 0);
    return (
        <>
            <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: props.left, top: 0, bottom: 0, width: LEFT_FADE }, leftStyle]}>
                <LinearGradient colors={[props.background, transparent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
            </Animated.View>
            <Animated.View pointerEvents="none" style={[{ position: 'absolute', right: 0, top: 0, bottom: 0, width: RIGHT_FADE }, rightStyle]}>
                <LinearGradient colors={[transparent, props.background]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
            </Animated.View>
        </>
    );
}

/**
 * Pan mode cannot nest the list inside a horizontal ScrollView: a
 * VirtualizedList takes its visible window from the nearest scroll ancestor,
 * and a horizontal one tells it nothing is on screen, so every row blanks.
 * The list stays the only scroller and the code column slides under a gutter
 * that never moves.
 */
function PannedRow(props: {
    shift: SharedValue<number>;
    gutter: React.ReactNode;
    width: number;
    gap: number;
    children: React.ReactNode;
}) {
    const style = useAnimatedStyle(() => ({ transform: [{ translateX: -props.shift.value }] }));
    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            {props.gutter}
            <View style={{ flex: 1, marginLeft: props.gap, overflow: 'hidden' }}>
                <Animated.View style={[{ width: props.width }, style]}>{props.children}</Animated.View>
            </View>
        </View>
    );
}

export function CodeCore(props: {
    code: string;
    language?: string;
    fileName?: string;
    /** Overrides the width-derived size; the pinch gesture is the only caller. */
    fontSize?: number;
    maxLines?: number;
    maxChars?: number;
    lineNumbers?: boolean;
    selectable?: boolean;
    header?: boolean;
    /** Soft-wrap long lines. Off pans the whole document sideways instead. */
    wrap?: boolean;
    /** 1-based line to bring into view once the list is laid out. */
    highlightLine?: number;
    /** Width available to the body, paddings already subtracted. */
    contentWidth?: number;
    contentPadding?: CodeContentPadding;
    onDerivedFontSize?: (size: number) => void;
}) {
    const { theme } = useUnistyles();
    const maxLines = props.maxLines ?? HOST_CODE_MAX_LINES;
    const maxChars = props.maxChars ?? HOST_CODE_MAX_CHARS;
    const selectable = props.selectable !== false;
    const lineNumbers = props.lineNumbers !== false;
    // A code card inside a plugin screen is a fixed-height excerpt, so it pans;
    // a whole-file view is read top to bottom, so it wraps.
    const wrap = props.wrap ?? props.header !== true;
    const bounded = React.useMemo(() => boundText(props.code, maxLines, maxChars), [maxChars, maxLines, props.code]);
    const language = syntaxLanguage(props.language, props.fileName);
    const plain = React.useMemo(() => bounded.text.split('\n'), [bounded.text]);
    const highlighted = React.useMemo(() => highlightCodeLines(bounded.text, language), [bounded.text, language]);
    const digits = String(Math.max(1, plain.length)).length;

    const [measuredWidth, setMeasuredWidth] = React.useState(0);
    const contentWidth = props.contentWidth ?? measuredWidth;
    const probeSizes = React.useMemo(() => {
        const base = props.fontSize ?? 12;
        return [base, base - 1, 11, 10, 12, 13];
    }, [props.fontSize]);
    const { charWidth, probe } = useMonoCharWidth(probeSizes);
    const derived = React.useMemo(
        () => contentWidth > 0 ? deriveFontSize(contentWidth, digits, 'file', charWidth) : 12,
        [charWidth, contentWidth, digits],
    );
    const onDerivedFontSize = props.onDerivedFontSize;
    React.useEffect(() => { onDerivedFontSize?.(derived); }, [derived, onDerivedFontSize]);
    const fontSize = props.fontSize ?? derived;
    const lineHeight = lineHeightFor(fontSize);
    const charW = charWidth(fontSize);
    const gutterWidth = lineNumbers ? fileGutterWidth(digits, charWidth(fontSize - 1)) : 0;
    const codeWidth = Math.max(charW * 8, contentWidth - gutterWidth - GAP - RIGHT_INSET);
    const cols = columnsFor(codeWidth, charW);
    const mono = Typography.mono();

    const layouts: LineLayout[] = React.useMemo(
        () => wrap && contentWidth > 0 ? layoutLines(plain, cols) : plain.map(() => ({ starts: [0], hang: 0 })),
        [cols, contentWidth, plain, wrap],
    );
    const offsets = React.useMemo(
        () => prefixSums(layouts.map((layout) => layout.starts.length * lineHeight)),
        [layouts, lineHeight],
    );
    // Panning needs the longest row's width so the scroller has something to
    // scroll and the right fade knows when it has run out.
    const widest = React.useMemo(
        () => wrap ? 0 : plain.reduce((max, line) => Math.max(max, expandTabs(line).length), 0) * charW,
        [charW, plain, wrap],
    );
    const scrollX = useSharedValue(0);
    const overflow = useSharedValue(0);
    React.useEffect(() => {
        overflow.value = Math.max(0, widest - codeWidth);
        scrollX.value = 0;
    }, [codeWidth, overflow, scrollX, widest]);
    const onScroll = useAnimatedScrollHandler((event) => { scrollX.value = event.contentOffset.x; });
    const shiftStart = useSharedValue(0);
    const horizontalPan = React.useMemo(
        () => Gesture.Pan()
            .activeOffsetX([-12, 12])
            .failOffsetY([-12, 12])
            .onBegin(() => { shiftStart.value = scrollX.value; })
            .onUpdate((event: GestureUpdateEvent<PanGestureHandlerEventPayload>) => {
                scrollX.value = Math.min(overflow.value, Math.max(0, shiftStart.value - event.translationX));
            }),
        [overflow, scrollX, shiftStart],
    );

    const listRef = React.useRef<React.ComponentRef<typeof Animated.FlatList<number>> | null>(null);
    const highlightLine = props.highlightLine;
    React.useEffect(() => {
        if (highlightLine === undefined || highlightLine <= 0 || highlightLine > plain.length) return;
        const frame = requestAnimationFrame(() => {
            listRef.current?.scrollToIndex({ index: highlightLine - 1, viewOffset: 40, animated: false });
        });
        return () => cancelAnimationFrame(frame);
    }, [highlightLine, layouts, plain.length]);

    const renderRow = (index: number) => {
        const layout = layouts[index]!;
        const rows = wrap ? sliceSpans(highlighted[index] ?? [{ text: plain[index] ?? '' }], layout.starts) : [highlighted[index] ?? [{ text: plain[index] ?? '' }]];
        const gutter = lineNumbers ? (
            <View style={{ width: gutterWidth, backgroundColor: theme.colors.surface }}>
                {rows.map((_, row) => (
                    <Text
                        key={row}
                        selectable={false}
                        style={{ ...mono, width: gutterWidth, textAlign: 'right', fontSize: fontSize - 1, lineHeight, color: theme.colors.diff.lineNumberText }}
                    >
                        {row === 0 ? index + 1 : ''}
                    </Text>
                ))}
            </View>
        ) : null;
        const code = rows.map((spans, row) => (
            <Text
                key={row}
                selectable={selectable}
                numberOfLines={1}
                ellipsizeMode="clip"
                style={{ ...mono, fontSize, lineHeight, color: theme.colors.syntaxDefault, paddingLeft: row === 0 ? 0 : layout.hang * charW }}
            >
                {spans.length === 0
                    ? ' '
                    : <SyntaxSpans spans={spans} palette={pagePalette(theme)} selectable={selectable} />}
            </Text>
        ));
        if (wrap) {
            return (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                    {gutter}
                    <View style={{ flex: 1, marginLeft: lineNumbers ? GAP : 0 }}>{code}</View>
                </View>
            );
        }
        return <PannedRow shift={scrollX} gutter={gutter} width={widest + RIGHT_INSET} gap={lineNumbers ? GAP : 0}>{code}</PannedRow>;
    };

    const truncated = bounded.omittedLines > 0 || bounded.omittedChars > 0;
    const footer = truncated ? (
        <Text style={{ color: theme.colors.textSecondary, fontSize: Math.min(11.5, fontSize), paddingHorizontal: props.header ? 12 : 0, paddingBottom: props.header ? 9 : 0, paddingTop: props.header ? 0 : 8, ...Typography.mono() }}>
            {plain.length} / {bounded.totalLines} lines
        </Text>
    ) : null;

    // The plugin card is a bounded excerpt inside someone else's scroller, so
    // it stays a plain column and pans; only the whole-file view virtualizes.
    if (props.header === true) {
        const pathSegments = (props.fileName ?? 'Source').split('/').filter(Boolean).map((label, index, segments) => ({
            label,
            ...(index === segments.length - 1 ? { icon: fileIcon(props.fileName ?? label).name } : {}),
        }));
        return (
            <View
                onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width - 24)}
                style={{ borderRadius: ui.radius.card, overflow: 'hidden', backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.diff.outline, marginBottom: 10 }}
            >
                <PathBreadcrumb segments={pathSegments} fullPath={props.fileName ?? 'Source'} inline
                    trailing={<Text style={{ color: theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono() }}>{language ?? 'plain text'}</Text>} />
                <View style={{ paddingVertical: 8 }}>
                    <Animated.ScrollView
                        horizontal
                        nestedScrollEnabled
                        showsHorizontalScrollIndicator
                        persistentScrollbar
                        onScroll={onScroll}
                        scrollEventThrottle={16}
                        contentContainerStyle={{ paddingHorizontal: 12 }}
                    >
                        <View>{plain.map((_, index) => <View key={index}>{renderRow(index)}</View>)}</View>
                    </Animated.ScrollView>
                    <EdgeFades scrollX={scrollX} overflow={overflow} left={gutterWidth + GAP} background={theme.colors.surface} />
                </View>
                {footer}
                {probe}
            </View>
        );
    }

    const padding = props.contentPadding ?? { horizontal: 0, top: 0, bottom: 0 };
    const list = (
        <Animated.FlatList
            ref={listRef}
            data={plain}
            extraData={layouts}
            keyExtractor={(_: unknown, index: number) => String(index)}
            renderItem={({ index }: ListRenderItemInfo<unknown>) => renderRow(index)}
            getItemLayout={(_: unknown, index: number) => ({
                length: (layouts[index]?.starts.length ?? 1) * lineHeight,
                offset: offsets[index] ?? 0,
                index,
            })}
            initialNumToRender={40}
            maxToRenderPerBatch={24}
            windowSize={7}
            // Inside the pan mode's horizontal scroller Android clips against
            // the wrong window and blanks every row, so only the wrapped list
            // takes the optimisation.
            removeClippedSubviews={Platform.OS === 'android' && wrap}
            showsVerticalScrollIndicator
            ListFooterComponent={footer}
            contentContainerStyle={{ paddingTop: padding.top, paddingBottom: padding.bottom, paddingHorizontal: padding.horizontal }}
            style={{ flex: 1, backgroundColor: theme.colors.surface }}
        />
    );

    // Same card the diff sits in, so file and diff share one white surface and
    // the palette gets its white-background contrast ratios.
    const card = {
        flex: 1,
        overflow: 'hidden' as const,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.diff.outline,
        backgroundColor: theme.colors.surface,
    };
    if (wrap) {
        return (
            <View style={card} onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width - padding.horizontal * 2)}>
                {list}
                {probe}
            </View>
        );
    }
    return (
        <GestureDetector gesture={horizontalPan}>
            <View style={card} onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width - padding.horizontal * 2)}>
                {list}
                <EdgeFades scrollX={scrollX} overflow={overflow} left={gutterWidth + GAP} background={theme.colors.surface} />
                {probe}
            </View>
        </GestureDetector>
    );
}
