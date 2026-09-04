import * as React from 'react';
import { ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, syntaxLanguage } from '@/components/code/syntaxHighlighting';
import { ui } from '@/components/ui';
import { PathBreadcrumb } from '@/components/PathBreadcrumb';
import { fileIcon } from '@/plugins/domain/fileIcon';

export const PLUGIN_CODE_MAX_LINES = 600;
export const PLUGIN_CODE_MAX_CHARS = 64 * 1024;
export const HOST_CODE_MAX_LINES = 2000;
export const HOST_CODE_MAX_CHARS = 256 * 1024;

export function CodeCore(props: {
    code: string;
    language?: string;
    fileName?: string;
    fontSize?: number;
    maxLines?: number;
    maxChars?: number;
    lineNumbers?: boolean;
    selectable?: boolean;
    header?: boolean;
    /** Soft-wrap long lines. Off pans the whole document sideways instead. */
    wrap?: boolean;
    /** 1-based line whose vertical offset the caller wants to scroll to. */
    highlightLine?: number;
    /** Top of `highlightLine` once laid out — a wrapped line is not at index × lineHeight. */
    onHighlightTop?: (top: number) => void;
}) {
    const { theme } = useUnistyles();
    const fontSize = props.fontSize ?? 12;
    const maxLines = props.maxLines ?? HOST_CODE_MAX_LINES;
    const maxChars = props.maxChars ?? HOST_CODE_MAX_CHARS;
    const selectable = props.selectable !== false;
    const lineNumbers = props.lineNumbers !== false;
    // A code card inside a plugin screen is a fixed-height excerpt, so it pans;
    // a whole-file view is read top to bottom, so it wraps.
    const wrap = props.wrap ?? props.header !== true;
    const bounded = React.useMemo(() => boundText(props.code, maxLines, maxChars), [maxChars, maxLines, props.code]);
    const language = syntaxLanguage(props.language, props.fileName);
    const lines = React.useMemo(() => highlightCodeLines(bounded.text, language), [bounded.text, language]);
    const lineHeight = Math.round(fontSize * 10 / 7);
    const mono = Typography.mono();
    const digits = String(Math.max(1, lines.length)).length;
    const gutterWidth = lineNumbers ? 16 + digits * Math.max(7, fontSize * 0.58) : 0;
    const truncated = bounded.omittedLines > 0 || bounded.omittedChars > 0;
    const highlightIndex = props.highlightLine === undefined ? -1 : props.highlightLine - 1;
    const onHighlightTop = props.onHighlightTop;
    const reportTop = React.useCallback((event: LayoutChangeEvent) => {
        onHighlightTop?.(event.nativeEvent.layout.y);
    }, [onHighlightTop]);
    const pathSegments = (props.fileName ?? 'Source').split('/').filter(Boolean).map((label, index, segments) => ({
        label,
        ...(index === segments.length - 1 ? { icon: fileIcon(props.fileName ?? label).name } : {}),
    }));

    // Both layouts below share these cells, so a number and its code can never
    // drift apart between the wrapped and the panned mode.
    const numberCells = lines.map((_, index) => (
        <Text key={index} selectable={false} style={{ ...mono, width: gutterWidth, paddingRight: 9, textAlign: 'right', fontSize, lineHeight, color: theme.colors.diff.lineNumberText }}>
            {index + 1}
        </Text>
    ));
    const codeCells = lines.map((line, index) => (
        <Text key={index} selectable={selectable} style={{ ...mono, minWidth: 24, fontSize, lineHeight, color: theme.colors.syntaxDefault }}>
            <SyntaxSpans spans={line} theme={theme} fallbackColor={theme.colors.syntaxDefault} selectable={selectable} />
            {line.length === 0 ? ' ' : null}
        </Text>
    ));
    const gutterColumn = { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.divider };

    // Wrapped: one row per logical line, so a number stays on its line's first
    // visual row and the continuation rows show an empty gutter — that gap is
    // the continuation marker. Panned: every line is exactly one visual row,
    // so the gutter can sit outside the scroller and still line up.
    const body = wrap ? (
        <View style={{ paddingVertical: props.header ? 8 : 0, paddingRight: 14 }}>
            {lines.map((_, index) => (
                <View
                    key={index}
                    style={{ flexDirection: 'row', alignItems: 'flex-start' }}
                    {...(index === highlightIndex ? { onLayout: reportTop } : {})}
                >
                    {lineNumbers && <View style={gutterColumn}>{numberCells[index]}</View>}
                    <View style={{ flex: 1, paddingLeft: lineNumbers ? 10 : 0 }}>{codeCells[index]}</View>
                </View>
            ))}
        </View>
    ) : (
        <View style={{ flexDirection: 'row', paddingVertical: props.header ? 8 : 0 }}>
            {lineNumbers && <View style={gutterColumn}>{numberCells}</View>}
            <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={{ flex: 1 }} contentContainerStyle={{ paddingLeft: lineNumbers ? 10 : 0, paddingRight: 14 }}>
                <View>
                    {lines.map((_, index) => (
                        <View key={index} {...(index === highlightIndex ? { onLayout: reportTop } : {})}>
                            {codeCells[index]}
                        </View>
                    ))}
                </View>
            </ScrollView>
        </View>
    );
    const footer = truncated ? (
        <Text style={{ color: theme.colors.textSecondary, fontSize: Math.min(11.5, fontSize), paddingHorizontal: props.header ? 12 : 0, paddingBottom: props.header ? 9 : 0, paddingTop: props.header ? 0 : 8, ...Typography.mono() }}>
            {lines.length} / {bounded.totalLines} lines
        </Text>
    ) : null;
    if (!props.header) {
        return <View>{body}{footer}</View>;
    }
    return (
        <View style={{ borderRadius: ui.radius.card, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, marginBottom: 10 }}>
            <PathBreadcrumb segments={pathSegments} fullPath={props.fileName ?? 'Source'} inline
                trailing={<Text style={{ color: theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono() }}>{language ?? 'plain text'}</Text>} />
            {body}
            {footer}
        </View>
    );
}
