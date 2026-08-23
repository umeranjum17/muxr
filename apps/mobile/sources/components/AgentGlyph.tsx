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
    amp: require('@/assets/agents/amp.png'),
    agy: require('@/assets/agents/antigravity.png'),
    antigravity: require('@/assets/agents/antigravity.png'),
    'antigravity-cli': require('@/assets/agents/antigravity.png'),
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
    kilo: require('@/assets/agents/kilocode.png'),
    kilocode: require('@/assets/agents/kilocode.png'),
    kimi: require('@/assets/agents/kimi.png'),
    kiro: require('@/assets/agents/kiro.png'),
    maki: require('@/assets/agents/maki.png'),
    mastracode: require('@/assets/agents/mastracode.png'),
    omp: require('@/assets/agents/omp.png'),
    opencode: require('@/assets/agents/opencode.png'),
    pi: require('@/assets/agents/pi.png'),
    qoder: require('@/assets/agents/qoder.png'),
    qodercli: require('@/assets/agents/qoder.png'),
} as const;

type KnownAgent = keyof typeof agentImages;

export const ACCENT = '#cba6f7'; // kept for components not wired to the theme; prefer theme.colors.accent

export const AgentGlyph = React.memo(
    (props: { name: string; size?: number; selected?: boolean; dim?: boolean }) => {
        const { theme } = useUnistyles();
        const size = props.size ?? 32;
        const letter = props.name.trim().charAt(0).toUpperCase() || '·';
        const selected = props.selected === true;
        const accent = theme.colors.accent;
        const image = agentImages[props.name.trim().toLowerCase() as KnownAgent];
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
