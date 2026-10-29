import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { WordWrappingText } from '@/components/WordWrappingText';

/**
 * The head of one first-run step screen, shared by both doors: where the step
 * sits in its branch, how long it takes, and what it asks. The title wraps
 * whole words, so at 270 dp and the largest text it takes more lines instead
 * of clipping.
 */
export function OnboardingStepHeader(props: { step: number; of: number; time: string; title: string; subtitle?: string }) {
    const styles = stylesheet;
    return (
        <View style={styles.head}>
            <View style={styles.progress} accessible accessibilityLabel={`Step ${props.step} of ${props.of}`}>
                {Array.from({ length: props.of }, (_, index) => (
                    <View key={index} style={[styles.segment, index < props.step && styles.segmentOn]} />
                ))}
            </View>
            {/* One line each: the row wraps whole items, and a text measured as
                two lines at some densities ran its frame into the title. */}
            <View style={styles.meta}>
                <Text numberOfLines={1} style={styles.metaText}>{`Step ${props.step} of ${props.of}`}</Text>
                <Text numberOfLines={1} style={styles.time}>{props.time}</Text>
            </View>
            <WordWrappingText fontSize={25} lineHeight={29} style={styles.title} accessibilityRole="header">{props.title}</WordWrappingText>
            {props.subtitle !== undefined && <Text style={styles.subtitle}>{props.subtitle}</Text>}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    head: { alignSelf: 'stretch', gap: 8 },
    progress: { flexDirection: 'row', gap: 4 },
    segment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.divider },
    segmentOn: { backgroundColor: theme.colors.accent },
    meta: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 12, rowGap: 2 },
    metaText: { ...Typography.default('semiBold'), fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary },
    time: { ...Typography.mono(), fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary },
    title: { ...Typography.default('semiBold'), fontSize: 25, lineHeight: 29, color: theme.colors.text },
    subtitle: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
}));
