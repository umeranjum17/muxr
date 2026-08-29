/**
 * Agent identity mark. One neutral tile for every agent kind — the brand is the
 * product, not a rainbow. Selected/active state is an accent ring, never a fill.
 * Linear/Notion-class: quiet until it has something to say.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

const agentImages = {
    omp: require('@/assets/agents/omp.png'),
} as const;

const themedAgentImages = {
    pi: {
        light: require('@/assets/agents/pi-light.png'),
        dark: require('@/assets/agents/pi-dark.png'),
    },
} as const;

type KnownAgent = keyof typeof agentImages;
type ThemedAgent = keyof typeof themedAgentImages;

export const ACCENT = '#cba6f7'; // kept for components not wired to the theme; prefer theme.colors.accent

export const AgentGlyph = React.memo(
    (props: { name: string; size?: number; selected?: boolean; dim?: boolean }) => {
        const { theme } = useUnistyles();
        const size = props.size ?? 32;
        const name = props.name.trim().toLowerCase();
        const letter = name.charAt(0).toUpperCase() || '·';
        const selected = props.selected === true;
        const accent = theme.colors.accent;
        const themed = themedAgentImages[name as ThemedAgent];
        const image = themed?.[theme.dark ? 'dark' : 'light'] ?? agentImages[name as KnownAgent];
        return (
            <View
                style={{
                    width: size,
                    height: size,
                    borderRadius: Math.max(6, size * 0.28),
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: selected ? 'rgba(203, 166, 247, 0.10)' : theme.colors.surfaceHigh,
                    borderWidth: 1,
                    borderColor: selected ? accent : theme.colors.divider,
                    opacity: props.dim === true ? 0.55 : 1,
                }}
            >
                {image === undefined ? (
                    <Text
                        style={{
                            color: selected ? accent : theme.colors.textSecondary,
                            fontSize: size * 0.42,
                            fontWeight: '600',
                        }}
                    >
                        {letter}
                    </Text>
                ) : (
                    <Image source={image} contentFit="contain" style={{ width: size * 0.58, height: size * 0.58 }} />
                )}
            </View>
        );
    },
);
