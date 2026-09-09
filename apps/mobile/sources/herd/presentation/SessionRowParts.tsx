/**
 * The one metadata line every session row shares: dim, mono, "verb · context",
 * each segment carrying its own tone. Mono because these are numbers and
 * agent-produced strings, and mono keeps them from jittering as they update.
 */

import * as React from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { SessionRowData } from '@/catalog/store';

/** Work that already landed steps back; only what is working or blocked stays bright. */
export function isSettledSession(session: Pick<SessionRowData, 'state' | 'hasUnread'>): boolean {
    return !session.hasUnread && (session.state === 'waiting' || session.state === 'disconnected');
}

export interface MetaSegment {
    text: string | null | undefined;
    /** Only where it means something: state verbs and diff counts. */
    color?: string;
    /** One field, two colours: `+26 −12` joins with a space, not a separator. */
    attached?: boolean;
}

export function SessionMetaLine({ segments, style }: { segments: readonly MetaSegment[]; style?: StyleProp<TextStyle> }) {
    const { theme } = useUnistyles();
    const visible = segments.filter((segment): segment is MetaSegment & { text: string } => segment.text !== null && segment.text !== undefined && segment.text !== '');
    if (visible.length === 0) return null;
    return (
        <Text numberOfLines={1} style={[{ fontSize: 12, lineHeight: 16, letterSpacing: -0.1, color: theme.colors.textSecondary, ...Typography.mono() }, style]}>
            {visible.flatMap((segment, index) => [
                ...(index === 0 ? [] : [<Text key={`separator-${index}`}>{segment.attached === true ? ' ' : ' · '}</Text>]),
                <Text key={index} {...(segment.color === undefined ? {} : { style: { color: segment.color } })}>{segment.text}</Text>,
            ])}
        </Text>
    );
}
