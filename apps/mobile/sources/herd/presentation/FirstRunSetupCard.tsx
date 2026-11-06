import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { loadAppConfig } from '@/catalog';
import { setupEmptyState } from '@/commercialization';
import { WordWrappingText } from '@/components/WordWrappingText';
import { useCompactWindow } from '@/components/useCompactWindow';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { SetupCommand } from './SetupCommand';

/**
 * One numbered step row: the round number badge beside a title (with an
 * optional inline tag) and hint, then whatever extra content the caller adds.
 * The single step style shared by every first-run screen, so a step drawn
 * outside the setup card matches the card's own steps exactly.
 */
export function SetupStep(props: {
    number: number;
    title: string;
    hint?: string;
    tag?: string;
    compact?: boolean;
    children?: React.ReactNode;
}) {
    const styles = stylesheet;
    return (
        <View style={[styles.step, props.compact && styles.compactStep]}>
            {!props.compact && <View style={styles.badge}><Text style={styles.badgeNumber}>{props.number}</Text></View>}
            <View style={props.compact ? styles.compactBody : styles.body}>
                <View style={styles.titleRow}>
                    <Text style={styles.stepText}>{props.title}</Text>
                    {props.tag !== undefined && (
                        <View style={styles.tag}><Text style={styles.tagText}>{props.tag}</Text></View>
                    )}
                </View>
                {props.hint !== undefined && <WordWrappingText fontSize={13} lineHeight={18} style={styles.stepHint}>{props.hint}</WordWrappingText>}
                {props.children}
            </View>
        </View>
    );
}

/**
 * The three-step first run, shared by the hosted landing and the never-paired
 * Herd: run muxr on the computer, connect this device, review access. Numbered
 * steps, no leading action glyphs; the only compact control is Copy. It carries
 * no pairing buttons (the screen keeps its own) and no progress state.
 *
 * `variant="command"` renders only step 1's command block + effects disclosure,
 * for the guided run step where the surrounding screen owns the progression.
 */
export function FirstRunSetupCard(props: {
    variant?: 'full' | 'command';
}) {
    const commandOnly = props.variant === 'command';
    const narrow = useCompactWindow();
    const compact = commandOnly && narrow;
    const styles = stylesheet;
    const setup = setupEmptyState(loadAppConfig().publicBaseUrl);
    return (
        <View style={styles.card}>
            <SetupStep
                number={1}
                compact={compact}
                title="On your computer"
                hint="muxr controls coding agents on a computer you operate. Paste this line in a terminal there: it installs muxr and sets it up."
            >
                <SetupCommand command={setup.command} />
                {setup.setupUrl !== undefined && (
                    <Pressable accessibilityRole="link" hitSlop={8} onPress={() => void openExternalUrl(setup.setupUrl!)}>
                        <Text style={styles.link}>Not installed? Setup guide</Text>
                    </Pressable>
                )}
            </SetupStep>
            {!commandOnly && <>
                <SetupStep number={2} title="Connect this device" hint="Scan the QR or paste its pairing link" />
                <SetupStep number={3} title="Review access" hint="Check the computer and access shown, then choose Pair" />
            </>}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        width: '100%',
        maxWidth: 360,
        alignSelf: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        padding: 16,
        gap: 16,
    },
    step: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    compactStep: { flexDirection: 'column' },
    compactBody: { alignSelf: 'stretch', gap: 4 },
    badge: {
        width: 24,
        height: 24,
        borderRadius: 999,
        backgroundColor: theme.colors.accentSubtle,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badgeNumber: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
    },
    body: {
        flex: 1,
        gap: 4,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    tag: {
        borderRadius: 999,
        backgroundColor: theme.colors.accentSubtle,
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    tagText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: theme.colors.text,
    },
    stepText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    stepHint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    link: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.accent,
        marginTop: 2,
    },
}));
