import * as React from 'react';
import { Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { speakReply, stopRealtimeSession } from '@/conversation';
import { Modal } from '@/modal';
import { humanError } from '@/utils/errors';

const COPIED_MS = 1_600;

/**
 * Copy and Speak under an agent's reply. Speak reads it through the existing
 * realtime voice session; tapping it again while it speaks puts it away.
 */
export function ReplyActions({ sessionId, markdown }: { sessionId: string; markdown: string }): React.JSX.Element {
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);
    const [speaking, setSpeaking] = React.useState(false);
    const mounted = React.useRef(true);
    React.useEffect(() => () => { mounted.current = false; }, []);

    const copy = () => {
        void Clipboard.setStringAsync(markdown).then((ok) => {
            if (ok === false) { Modal.alert('Copy failed', 'The system clipboard did not take the reply.'); return; }
            setCopied(true);
            setTimeout(() => { if (mounted.current) setCopied(false); }, COPIED_MS);
        }).catch((error: unknown) => Modal.alert('Copy failed', humanError(error).message));
    };
    const speak = () => {
        if (speaking) { stopRealtimeSession(); return; }
        setSpeaking(true);
        void speakReply({ sessionId, markdown })
            .catch((error: unknown) => Modal.alert("Couldn't read it aloud", humanError(error).message))
            .finally(() => { if (mounted.current) setSpeaking(false); });
    };
    const button = (label: string, icon: React.ComponentProps<typeof Ionicons>['name'], onPress: () => void, selected: boolean) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} hitSlop={6}
            style={({ pressed }) => ({ width: 34, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
            <Ionicons name={icon} size={17} color={selected ? theme.colors.text : theme.colors.textSecondary} />
        </Pressable>
    );
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -6 }}>
            {button(copied ? 'Copied' : 'Copy reply', copied ? 'checkmark' : 'copy-outline', copy, copied)}
            {button(speaking ? 'Stop reading aloud' : 'Speak reply', speaking ? 'stop-circle-outline' : 'play-circle-outline', speak, speaking)}
        </View>
    );
}
