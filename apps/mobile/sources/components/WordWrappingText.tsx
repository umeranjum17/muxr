import * as React from 'react';
import { ScrollView, StyleSheet, Text, View, type TextProps } from 'react-native';

/** Wrap whole words; shrink only an oversized word (or a single-line label). */
export function WordWrappingText({ children, style, fontSize, lineHeight, availableWidth, onWordWidth, ...props }:
    Omit<TextProps, 'children'> & { children: string; fontSize: number; lineHeight?: number; availableWidth?: number; onWordWidth?: (width: number) => void }) {
    const [width, setWidth] = React.useState(0);
    const [wordWidths, setWordWidths] = React.useState<Record<string, number>>({});
    const words = props.numberOfLines === 1 ? [children] : [...new Set(children.split(/\s+/).filter(Boolean))];
    const measured = [...new Set([...words, children])];
    const widest = Math.max(0, ...words.map((word) => wordWidths[word] ?? 0));
    // A parent's budget can still be narrowed by borders or flex layout.
    const lineWidth = Math.min(availableWidth ?? width, width);
    const ready = lineWidth > 0 && measured.every((word) => wordWidths[word] > 0);
    const scale = widest > lineWidth ? lineWidth / (widest + 1) : 1;
    React.useEffect(() => { onWordWidth?.(widest); }, [widest, onWordWidth]);
    return (
        <View style={[styles.container, availableWidth !== undefined && { width: Math.min(availableWidth, wordWidths[children] ?? availableWidth) }]}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <Text {...props} style={[style, {
                fontSize: fontSize * scale,
                lineHeight: lineHeight === undefined ? undefined : lineHeight * scale,
                opacity: ready ? 1 : 0,
            }]}>{children}</Text>
            {/* Horizontal content measures unconstrained words on both platforms.
                It never paints or enters the accessibility tree. Unistyles' web
                style handles are opaque, so font metrics are explicit props. */}
            <ScrollView horizontal pointerEvents="none" accessible={false} aria-hidden
                accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                style={styles.measure}>
                {measured.map((word) => (
                    <Text key={word} style={[style, styles.word, { fontSize, lineHeight }]} onLayout={(event) => {
                        // RNW reports integer offsetWidth; reserve the lost
                        // fractional pixel so a fitting label cannot ellipsize.
                        const measuredWidth = event.nativeEvent.layout.width + 1;
                        setWordWidths((current) => current[word] === measuredWidth ? current : { ...current, [word]: measuredWidth });
                    }}>{word}</Text>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { alignSelf: 'stretch', flexShrink: 1, minWidth: 0 },
    measure: { position: 'absolute', height: 0, opacity: 0 },
    word: { alignSelf: 'flex-start', flexShrink: 0 },
});
