/**
 * Warp-style row parts shared by every session surface: one state glyph in the
 * gutter, one dim mono metadata line in "verb · context" grammar. Both lists
 * and the session screen render the same grammar, on the same 24pt text grid,
 * so a row reads the same wherever it appears.
 */

import * as React from 'react';
import { StyleProp, Text, TextStyle, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { SessionRowData } from '@/sync/storage';
import type { SessionStateColors } from '@/utils/sessionUtils';
import { StatusDot } from './StatusDot';

/** Gutter width plus its gap: every metadata line hangs off this one column. */
export const SESSION_GLYPH_COLUMN = 24;

/** Work that already landed steps back; only what is working or blocked stays bright. */
export function isSettledSession(session: Pick<SessionRowData, 'state' | 'hasUnread'>): boolean {
    return !session.hasUnread && (session.state === 'waiting' || session.state === 'disconnected');
}

/**
 * A check means finished, so only a live session that stopped working earns
 * one; a session that went away keeps a dot, dimmed. The gutter is exactly the
 * glyph box — padding around a centred icon is what makes a row look off-centre
 * on the left.
 */
export function SessionStateGlyph({ session, status }: {
    session: Pick<SessionRowData, 'state' | 'hasUnread' | 'hasDraft'>;
    status: SessionStateColors;
}) {
    const { theme } = useUnistyles();
    const glyph = session.hasUnread
        ? <StatusDot color={status.dotColor} isPulsing={false} size={7} />
        : session.state === 'waiting' && session.hasDraft
            ? <Ionicons name="create-outline" size={12} color={theme.colors.textSecondary} />
            : session.state === 'waiting'
                ? <Ionicons name="checkmark" size={13} color={theme.colors.textSecondary} />
                : session.state === 'disconnected'
                    ? <StatusDot color={status.dotColor} isPulsing={false} size={7} />
                    : <StatusDot color={status.dotColor} isPulsing={status.isPulsing} size={7} />;
    return <View style={{ width: 16, height: 20, alignItems: 'center', justifyContent: 'center' }}>{glyph}</View>;
}

export interface MetaSegment {
    text: string | null | undefined;
    /** Only where it means something: state verbs and diff counts. */
    color?: string;
    /** One field, two colours: `+26 −12` joins with a space, not a separator. */
    attached?: boolean;
}

/**
 * Each segment keeps its own colour, so a line reads "vibing · +26 −12 · repo"
 * with the counts toned rather than one flat grey run-on. Mono throughout:
 * these are numbers and agent-produced strings, and mono keeps them from
 * jittering as they update.
 */
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
