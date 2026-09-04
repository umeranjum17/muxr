import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { Theme } from '@/theme';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { highlightCodeLines, syntaxLanguage, type SyntaxSpan } from '@/components/code/syntaxHighlighting';
import { pagePalette, tokenColor, type SyntaxPalette } from '@/components/code/syntaxPalette';

export const MAX_RENDER_LINES = 2000;

interface SimpleSyntaxHighlighterProps {
    code: string;
    language: string | null;
    selectable: boolean;
    /** One Text per physical line, no soft-wrap (for horizontal scrollers). */
    nowrap?: boolean;
    /** One Text per physical line with a number gutter; long lines wrap under it. */
    lineNumbers?: boolean;
    fontSize?: number;
}

export function SyntaxSpans(props: { spans: SyntaxSpan[]; palette: SyntaxPalette; selectable?: boolean; markColor?: string }) {
    return <>{props.spans.map((span, index) => <Text key={index} selectable={props.selectable}
        style={{
            color: tokenColor(props.palette, span.type),
            ...(span.mark === true && props.markColor !== undefined ? { backgroundColor: props.markColor } : {}),
        }}>{span.text}</Text>)}</>;
}

export const SimpleSyntaxHighlighter = React.memo(function SimpleSyntaxHighlighter({
    code,
    language,
    selectable,
    nowrap = false,
    lineNumbers = false,
    fontSize = 14,
}: SimpleSyntaxHighlighterProps) {
    const { theme } = useUnistyles();
    const bounded = React.useMemo(() => boundText(code, MAX_RENDER_LINES, 64 * 1024), [code]);
    const resolved = syntaxLanguage(language ?? undefined);
    const lines = React.useMemo(() => highlightCodeLines(bounded.text, resolved), [bounded.text, resolved]);
    const lineHeight = Math.round(fontSize * 10 / 7);
    const fontStyle = {
        ...Typography.mono(),
        fontSize,
        lineHeight,
        ...(nowrap ? { whiteSpace: 'pre' as const } : {}),
        ...(lineNumbers ? { whiteSpace: 'pre-wrap' as const } : {}),
    };
    const truncation = bounded.omittedChars > 0 ? <Text selectable={false} style={{ color: theme.colors.textSecondary, fontSize, padding: 8 }}>
        showing {bounded.totalLines - bounded.omittedLines} of {bounded.totalLines} lines ({bounded.omittedLines} omitted, {bounded.omittedChars} chars)
    </Text> : null;
    const palette = pagePalette(theme);
    const renderLine = (line: SyntaxSpan[]) => line.length === 0 ? ' ' : <SyntaxSpans spans={line} palette={palette} selectable={selectable} />;

    if (lineNumbers) {
        const gutterWidth = String(lines.length).length * (fontSize * 0.62) + 10;
        return <View>
            {lines.map((line, index) => <View key={index} style={{ flexDirection: 'row' }}>
                <Text selectable={false} style={{ ...fontStyle, width: gutterWidth, textAlign: 'right', paddingRight: 8, color: theme.colors.diff.lineNumberText }}>{index + 1}</Text>
                <Text selectable={selectable} style={{ ...fontStyle, flex: 1 }}>{renderLine(line)}</Text>
            </View>)}
            {truncation}
        </View>;
    }

    if (nowrap) {
        return <View style={{ flexShrink: 0, alignSelf: 'flex-start' }}>
            {lines.map((line, index) => <Text key={index} numberOfLines={1} selectable={selectable} style={fontStyle}>{renderLine(line)}</Text>)}
            {truncation}
        </View>;
    }

    return <View>
        <Text selectable={selectable} style={fontStyle}>
            {lines.map((line, index) => <React.Fragment key={index}>{renderLine(line)}{index < lines.length - 1 ? '\n' : null}</React.Fragment>)}
        </Text>
        {truncation}
    </View>;
});
