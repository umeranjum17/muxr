import * as React from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

/** Keep words intact, shrinking only when a word cannot fit the title's line. */
export function WrappingTitle({ children, style, selectable }: { children: string; style: StyleProp<TextStyle>; selectable?: boolean }) {
    const [width, setWidth] = React.useState(0);
    const [wordWidths, setWordWidths] = React.useState<Record<string, number>>({});
    const words = [...new Set(children.split(/\s+/).filter(Boolean))];
    const base = StyleSheet.flatten(style);
    const widest = Math.max(0, ...words.map((word) => wordWidths[word] ?? 0));
    const ready = width > 0 && words.every((word) => wordWidths[word] > 0);
    const scale = widest > width ? width / (widest + 1) : 1;
    return (
        <View style={styles.container} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <Text accessibilityRole="header" selectable={selectable} style={[style, {
                fontSize: (base.fontSize ?? 14) * scale,
                lineHeight: (base.lineHeight ?? base.fontSize ?? 14) * scale,
                opacity: ready ? 1 : 0,
            }]}>{children}</Text>
            {/* A horizontal scroller measures words without imposing the line's
                width, on native and web alike. It never paints or enters AX. */}
            <ScrollView horizontal pointerEvents="none" accessible={false}
                accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                style={styles.measure}>
                {words.map((word) => (
                    <Text key={word} style={[style, styles.word]} onLayout={(event) => {
                        const measured = event.nativeEvent.layout.width;
                        setWordWidths((current) => current[word] === measured ? current : { ...current, [word]: measured });
                    }}>{word}</Text>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { alignSelf: 'stretch' },
    measure: { position: 'absolute', height: 0, opacity: 0 },
    word: { alignSelf: 'flex-start', flexShrink: 0 },
});
