/** Agent identity mark rendered as a neutral, tile-free glyph. */

import * as React from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';
import { agentImageKind, type AgentImageKind } from './agentImageKind';

const agentImages = {
    amp: require('@/assets/agents/amp.png'),
    antigravity: require('@/assets/agents/antigravity.png'),
    claude: require('@/assets/agents/claude.png'),
    cline: require('@/assets/agents/cline.png'),
    codex: require('@/assets/agents/codex.png'),
    copilot: require('@/assets/agents/copilot.png'),
    cursor: require('@/assets/agents/cursor.png'),
    devin: require('@/assets/agents/devin.png'),
    droid: require('@/assets/agents/droid.png'),
    gemini: require('@/assets/agents/gemini.png'),
    grok: require('@/assets/agents/grok.png'),
    hermes: require('@/assets/agents/hermes.png'),
    kilocode: require('@/assets/agents/kilocode.png'),
    kimi: require('@/assets/agents/kimi.png'),
    kiro: require('@/assets/agents/kiro.png'),
    maki: require('@/assets/agents/maki.png'),
    mastracode: require('@/assets/agents/mastracode.png'),
    omp: require('@/assets/agents/omp.png'),
    opencode: require('@/assets/agents/opencode.png'),
    pi: require('@/assets/agents/pi.png'),
    qoder: require('@/assets/agents/qoder.png'),
    shell: require('@/assets/agents/shell.png'),
} as const satisfies Record<AgentImageKind, unknown>;

export const ACCENT = '#cba6f7'; // kept for components not wired to the theme; prefer theme.colors.accent

export const AgentGlyph = React.memo(
    (props: { name: string; size?: number; selected?: boolean; dim?: boolean }) => {
        const { theme } = useUnistyles();
        const size = props.size ?? 32;
        const name = props.name.trim().toLowerCase();
        const letter = name.charAt(0).toUpperCase() || '·';
        const selected = props.selected === true;
        const kind = agentImageKind(name);
        const image = kind === undefined ? undefined : agentImages[kind];
        const color = selected || theme.dark ? theme.colors.text : theme.colors.textSecondary;
        return (
            <View
                style={{
                    width: size,
                    height: size,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: props.dim === true ? 0.55 : 1,
                }}
            >
                {image === undefined ? (
                    <Text
                        style={{
                            color,
                            fontSize: size * 0.68,
                            fontWeight: '600',
                        }}
                    >
                        {letter}
                    </Text>
                ) : (
                    <Image
                        source={image}
                        contentFit="contain"
                        tintColor={color}
                        style={{ width: size, height: size }}
                    />
                )}
            </View>
        );
    },
);
