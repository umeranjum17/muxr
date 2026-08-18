import React, { useMemo } from 'react';
import { View, Text, ViewStyle } from 'react-native';
import { calculateUnifiedDiff, DiffToken } from '@/components/diff/calculateDiff';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import { StyleSheet } from 'react-native-unistyles';


interface DiffViewProps {
    oldText: string;
    newText: string;
    contextLines?: number;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
    showDiffStats?: boolean;
    oldTitle?: string;
    newTitle?: string;
    style?: ViewStyle;
    maxHeight?: number;
    wrapLines?: boolean;
    fontScaleX?: number;
}

/**
 * GitHub-style rows: a quiet line-number gutter with a hairline rule, then
 * tinted bands for adds/removes over whatever card the diff sits in — no
 * background slab of its own, so it reads as part of the surrounding card.
 */
export const DiffView: React.FC<DiffViewProps> = ({
    oldText,
    newText,
    contextLines = 3,
    showLineNumbers = true,
    showPlusMinusSymbols = true,
    wrapLines = false,
    style,
    fontScaleX = 1,
}) => {
    const { theme } = useUnistyles();
    const colors = theme.colors.diff;

    const { hunks } = useMemo(() => {
        return calculateUnifiedDiff(oldText, newText, contextLines);
    }, [oldText, newText, contextLines]);

    const formatLineContent = (content: string) => content.trimEnd();

    const renderLineContent = (content: string, baseColor: string, tokens?: DiffToken[]) => {
        const formatted = formatLineContent(content);

        if (tokens && tokens.length > 0) {
            let processedLeadingSpaces = false;

            return tokens.map((token, idx) => {
                if (!processedLeadingSpaces && token.value) {
                    const leadingMatch = token.value.match(/^( +)/);
                    if (leadingMatch) {
                        processedLeadingSpaces = true;
                        const leadingDots = '·'.repeat(leadingMatch[0].length);
                        const restOfToken = token.value.slice(leadingMatch[0].length);

                        if (token.added || token.removed) {
                            return (
                                <Text key={idx}>
                                    <Text style={{ color: colors.leadingSpaceDot }}>{leadingDots}</Text>
                                    <Text style={{
                                        backgroundColor: token.added ? colors.inlineAddedBg : colors.inlineRemovedBg,
                                        color: token.added ? colors.inlineAddedText : colors.inlineRemovedText,
                                    }}>
                                        {restOfToken}
                                    </Text>
                                </Text>
                            );
                        }
                        return (
                            <Text key={idx}>
                                <Text style={{ color: colors.leadingSpaceDot }}>{leadingDots}</Text>
                                <Text style={{ color: baseColor }}>{restOfToken}</Text>
                            </Text>
                        );
                    }
                    processedLeadingSpaces = true;
                }

                if (token.added || token.removed) {
                    return (
                        <Text
                            key={idx}
                            style={{
                                backgroundColor: token.added ? colors.inlineAddedBg : colors.inlineRemovedBg,
                                color: token.added ? colors.inlineAddedText : colors.inlineRemovedText,
                            }}
                        >
                            {token.value}
                        </Text>
                    );
                }
                return <Text key={idx} style={{ color: baseColor }}>{token.value}</Text>;
            });
        }

        const leadingSpaces = formatted.match(/^( +)/);
        const leadingDots = leadingSpaces ? '·'.repeat(leadingSpaces[0].length) : '';
        const mainContent = leadingSpaces ? formatted.slice(leadingSpaces[0].length) : formatted;

        return (
            <>
                {leadingDots && <Text style={{ color: colors.leadingSpaceDot }}>{leadingDots}</Text>}
                <Text style={{ color: baseColor }}>{mainContent}</Text>
            </>
        );
    };

    const renderDiffContent = () => {
        const rows: React.ReactNode[] = [];

        hunks.forEach((hunk, hunkIndex) => {
            if (hunkIndex > 0) {
                rows.push(
                    <View
                        key={`hunk-header-${hunkIndex}`}
                        style={[styles.hunkHeader, {
                            backgroundColor: colors.hunkHeaderBg,
                            borderTopColor: colors.outline,
                        }]}
                    >
                        <Text
                            numberOfLines={1}
                            style={{
                                ...Typography.mono(),
                                fontSize: 11,
                                lineHeight: 16,
                                color: colors.hunkHeaderText,
                                transform: [{ scaleX: fontScaleX }],
                            }}
                        >
                            {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                        </Text>
                    </View>
                );
            }

            hunk.lines.forEach((line, lineIndex) => {
                const isAdded = line.type === 'add';
                const isRemoved = line.type === 'remove';
                const textColor = isAdded ? colors.addedText : isRemoved ? colors.removedText : colors.contextText;
                const bgColor = isAdded ? colors.addedBg : isRemoved ? colors.removedBg : 'transparent';

                rows.push(
                    <View
                        key={`line-${hunkIndex}-${lineIndex}`}
                        style={{ flexDirection: 'row', backgroundColor: bgColor }}
                    >
                        {showLineNumbers && (
                            <Text
                                style={[styles.gutter, {
                                    color: colors.lineNumberText,
                                    borderRightColor: colors.outline,
                                    transform: [{ scaleX: fontScaleX }],
                                }]}
                            >
                                {String(line.type === 'remove' ? line.oldLineNumber :
                                       line.type === 'add' ? line.newLineNumber :
                                       line.oldLineNumber)}
                            </Text>
                        )}
                        <Text
                            numberOfLines={wrapLines ? undefined : 1}
                            style={{
                                ...Typography.mono(),
                                flex: 1,
                                fontSize: 13,
                                lineHeight: 20,
                                paddingHorizontal: 8,
                                transform: [{ scaleX: fontScaleX }],
                            }}
                        >
                            {showPlusMinusSymbols && (
                                <Text style={{ color: isAdded ? theme.colors.diff.success : isRemoved ? theme.colors.diff.error : textColor, fontWeight: isAdded || isRemoved ? '600' : 'normal' }}>
                                    {`${isAdded ? '+' : isRemoved ? '-' : ' '} `}
                                </Text>
                            )}
                            {renderLineContent(line.content, textColor, line.tokens)}
                        </Text>
                    </View>
                );
            });
        });

        return rows;
    };

    return (
        <View style={[{ flex: 1, overflow: 'hidden' }, style]}>
            {renderDiffContent()}
        </View>
    );
};

const styles = StyleSheet.create({
    gutter: {
        ...Typography.mono(),
        width: 40,
        flexShrink: 0,
        paddingRight: 8,
        paddingLeft: 4,
        textAlign: 'right',
        fontSize: 11,
        lineHeight: 20,
        borderRightWidth: StyleSheet.hairlineWidth,
    },
    hunkHeader: {
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
});
