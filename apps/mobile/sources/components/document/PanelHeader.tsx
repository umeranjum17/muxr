import * as React from 'react';
import { StyleSheet } from 'react-native';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * The panel's own 40 dp header: what file this is, and how much of it changed.
 *
 * This replaces the 44 dp breadcrumb on the page. The navigation bar already
 * names the file, so repeating the name below it in a second type size spent a
 * sixth of the viewport saying one thing twice.
 */

const BADGES: Record<string, { label: string; background: string; text?: string }> = {
    typescript: { label: 'TS', background: '#3178c6' },
    tsx: { label: 'TS', background: '#3178c6' },
    javascript: { label: 'JS', background: '#e8c547', text: '#14161a' },
    jsx: { label: 'JS', background: '#e8c547', text: '#14161a' },
    python: { label: 'PY', background: '#4b8bbe' },
    go: { label: 'GO', background: '#00add8' },
    rust: { label: 'RS', background: '#dea584', text: '#14161a' },
    kotlin: { label: 'KT', background: '#7f52ff' },
    swift: { label: 'SW', background: '#f05138' },
    java: { label: 'JA', background: '#b07219' },
    ruby: { label: 'RB', background: '#cc342d' },
    bash: { label: 'SH', background: '#89e051', text: '#14161a' },
    shell: { label: 'SH', background: '#89e051', text: '#14161a' },
};

function badgeFor(language: string | undefined, path: string | undefined): { label: string; background: string; text?: string } {
    const known = language === undefined ? undefined : BADGES[language];
    if (known !== undefined) return known;
    const extension = (path ?? '').split('.').pop() ?? '';
    return { label: extension.slice(0, 2).toUpperCase() || '··', background: '#8b949e', text: '#14161a' };
}

export const PANEL_HEADER_HEIGHT = 40;

export function PanelHeader(props: {
    path?: string;
    language?: string;
    added?: number;
    removed?: number;
    /** Shown when there is nothing changed to count, e.g. file metadata. */
    trailing?: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const code = theme.colors.code;
    const badge = badgeFor(props.language, props.path);
    const segments = (props.path ?? '').split('/').filter(Boolean);
    const directory = segments.slice(0, -1).join('/');
    const counts = (props.added ?? 0) + (props.removed ?? 0) > 0;

    return (
        <View style={{
            height: PANEL_HEADER_HEIGHT,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12,
            gap: 8,
            backgroundColor: code.surfaceRaised,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: code.hairline,
        }}>
            <View style={{
                width: 20,
                height: 20,
                borderRadius: 5,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: badge.background,
            }}>
                <Text style={{ ...Typography.mono('semiBold'), fontSize: 10, color: badge.text ?? '#ffffff' }}>
                    {badge.label}
                </Text>
            </View>
            {/* Head-ellipsized: the tail of a path is what identifies it. */}
            <Text
                numberOfLines={1}
                ellipsizeMode="head"
                style={{ ...Typography.mono(), flex: 1, fontSize: 11.5, color: code.dim }}
            >
                {directory === '' ? ' ' : directory}
            </Text>
            {counts ? (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ ...Typography.mono('semiBold'), fontSize: 11.5, color: code.addedMark }}>
                        {`+${props.added ?? 0}`}
                    </Text>
                    <Text style={{ ...Typography.mono('semiBold'), fontSize: 11.5, color: code.removedMark }}>
                        {`−${props.removed ?? 0}`}
                    </Text>
                </View>
            ) : props.trailing}
        </View>
    );
}
