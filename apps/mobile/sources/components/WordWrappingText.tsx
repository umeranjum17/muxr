import * as React from 'react';
import { ScrollView, Text, View, type TextProps } from 'react-native';

/** Wrap whole words; shrink only a word wider than the line. */
export function WordWrappingText({ children, style, fontSize, lineHeight, ...props }:
    Omit<TextProps, 'children'> & { children: string; fontSize: number; lineHeight?: number }) {
    const [width, setWidth] = React.useState(0);
    const [wordWidths, setWordWidths] = React.useState<Record<string, number>>({});
    const words = [...new Set(children.split(/\s+/).filter(Boolean))];
    const widest = Math.max(0, ...words.map((word) => wordWidths[word] ?? 0));
    const ready = width > 0 && words.every((word) => wordWidths[word] > 0);
    // Before the first layout the line is 0: a 0 font size crashes Android.
    const scale = ready && widest > width ? width / (widest + 1) : 1;
    return (
        <View style={styles.container}
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
                {words.map((word) => (
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

// Plain objects: jest/vitest react-native mocks used by screen tests carry no StyleSheet.
const styles = {
    container: { alignSelf: 'stretch', flexShrink: 1, minWidth: 0 },
    measure: { position: 'absolute', height: 0, opacity: 0 },
    word: { alignSelf: 'flex-start', flexShrink: 0 },
} as const;
