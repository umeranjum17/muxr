import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { boundText } from '@/utils/boundedText';
import { SyntaxSpans } from '@/components/SimpleSyntaxHighlighter';
import { highlightCodeLines, syntaxLanguage } from '@/components/code/syntaxHighlighting';
import { ui } from '@/components/ui';
import { PathBreadcrumb } from '@/components/PathBreadcrumb';
import { fileIcon } from '@/plugins/domain/fileIcon';

export const SyntaxHighlightedCode = React.memo(function SyntaxHighlightedCode(props: { code: string; language?: string; fileName?: string }) {
    const { theme } = useUnistyles();
    const bounded = React.useMemo(() => boundText(props.code, 600, 64 * 1024), [props.code]);
    const language = syntaxLanguage(props.language, props.fileName);
    const lines = React.useMemo(() => highlightCodeLines(bounded.text, language), [bounded.text, language]);
    const digits = String(Math.max(1, lines.length)).length;
    const mono = Typography.mono();
    const fontSize = 12;
    const lineHeight = 19;
    const gutterWidth = 16 + digits * 7;
    const pathSegments = (props.fileName ?? 'Source').split('/').filter(Boolean).map((label, index) => ({
        label,
        ...(index === 0 ? { icon: fileIcon(props.fileName ?? label).name } : {}),
    }));
    return (
        <View style={{ borderRadius: ui.radius.card, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, marginBottom: 10 }}>
            <PathBreadcrumb segments={pathSegments} fullPath={props.fileName ?? 'Source'} inline
                trailing={<Text style={{ color: theme.colors.textSecondary, fontSize: 10.5, ...Typography.mono() }}>{language ?? 'plain text'}</Text>} />
            <View style={{ flexDirection: 'row', paddingVertical: 8 }}>
                {/* The gutter stays put while long code moves underneath it. A
                    scrolling line number is no longer a line number. */}
                <View style={{ width: gutterWidth, paddingRight: 9, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.divider }}>
                    {lines.map((_, index) => <Text key={index} style={{ ...mono, textAlign: 'right', fontSize, lineHeight, color: theme.colors.diff.lineNumberText }}>{index + 1}</Text>)}
                </View>
                <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ paddingLeft: 10, paddingRight: 14 }}>
                    <View>
                        {lines.map((line, index) => <Text key={index} selectable style={{ ...mono, minWidth: 24, fontSize, lineHeight, color: theme.colors.syntaxDefault }}>
                            <SyntaxSpans spans={line} theme={theme} fallbackColor={theme.colors.syntaxDefault} selectable />
                            {line.length === 0 ? ' ' : null}
                        </Text>)}
                    </View>
                </ScrollView>
            </View>
            {(bounded.omittedLines > 0 || bounded.omittedChars > 0) && <Text style={{ color: theme.colors.textSecondary, fontSize: 11, paddingHorizontal: 12, paddingBottom: 9, ...Typography.mono() }}>
                {lines.length} / {bounded.totalLines} lines
            </Text>}
        </View>
    );
});
