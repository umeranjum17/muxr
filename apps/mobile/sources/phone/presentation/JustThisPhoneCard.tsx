import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { phoneChatExists } from '../application/phoneChat';

/** First-run entry for a person with no computer; once a chat exists it reads as the way back into it. */
export function JustThisPhoneCard() {
    const router = useRouter();
    const [kept, setKept] = React.useState(false);
    React.useEffect(() => {
        let alive = true;
        void phoneChatExists().then((yes) => { if (alive) setKept(yes); }, () => undefined);
        return () => { alive = false; };
    }, []);
    const title = kept ? 'Continue your chat' : 'Just this phone';
    const sub = kept ? 'Your agent on this phone' : 'No computer? Sign in to your AI plan and chat with an agent on this phone.';
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}. ${sub}`}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            onPress={() => router.push('/phone')}
        >
            <View style={styles.icon}><Ionicons name="phone-portrait-outline" size={22} color={styles.glyph.color} /></View>
            <View style={styles.words}>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.sub}>{sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={styles.sub.color} />
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: {
        width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12,
        borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh,
    },
    pressed: { opacity: 0.85 },
    icon: {
        width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    glyph: { color: theme.colors.text },
    words: { flex: 1, minWidth: 0, gap: 2 },
    title: { ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.text },
    sub: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
}));
