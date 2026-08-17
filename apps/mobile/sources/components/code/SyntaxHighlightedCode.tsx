import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, syntaxLanguage } from './syntaxHighlighting';

export const SyntaxHighlightedCode = React.memo(function SyntaxHighlightedCode(props: { code: string; language?: string; fileName?: string }) {
    const { theme } = useUnistyles();
    const bounded = React.useMemo(() => boundText(props.code, 600, 64 * 1024), [props.code]);
    const language = syntaxLanguage(props.language, props.fileName);
    const lines = React.useMemo(() => highlightCodeLines(bounded.text, language), [bounded.text, language]);
    const digits = String(Math.max(1, lines.length)).length;
    const mono = Typography.mono();
    const fontSize = 13;
    const lineHeight = 20;
    return (
        <View style={{ borderRadius: 10, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh, marginBottom: 8 }}>
            <View style={{ minHeight: 32, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12, flex: 1 }}>{props.fileName ?? 'Source'}</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 10, letterSpacing: 0.5, marginLeft: 12 }}>{(language ?? 'plain text').toUpperCase()}</Text>
            </View>
            <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ paddingVertical: 8 }}>
                <View>
                    {lines.map((line, index) => (
                        <View key={index} style={{ flexDirection: 'row', minHeight: lineHeight }}>
                            <Text style={{ ...mono, width: 12 + digits * 8, paddingRight: 10, textAlign: 'right', fontSize, lineHeight, color: theme.colors.textSecondary, opacity: 0.55 }}>
                                {index + 1}
                            </Text>
                            <Text selectable style={{ ...mono, minWidth: 24, paddingRight: 14, fontSize, lineHeight, color: theme.colors.syntaxDefault }}>
                                <SyntaxSpans spans={line} theme={theme} fallbackColor={theme.colors.syntaxDefault} selectable />
                                {line.length === 0 ? ' ' : null}
                            </Text>
                        </View>
                    ))}
                </View>
            </ScrollView>
            {(bounded.omittedLines > 0 || bounded.omittedChars > 0) && <Text style={{ color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 12, paddingBottom: 8 }}>
                showing {lines.length} of {bounded.totalLines} lines
            </Text>}
        </View>
    );
});
