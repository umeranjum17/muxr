import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The one designed missing-file state both entry points share: a tapped
 * terminal path to no file, and a Files preview of a deleted file.
 */
export function MissingFileState(props: {
    path: string;
    onOpenFolder: () => void;
    onBack: () => void;
}) {    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current);
    }, []);
    const copyPath = React.useCallback(() => {
        void Clipboard.setStringAsync(props.path).then((succeeded) => {
            if (!succeeded) {
                Modal.alert('Copy failed', 'Please try again.');
                return;
            }
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
        }).catch(() => {
            Modal.alert('Copy failed', 'Please try again.');
        });
    }, [props.path]);

    return (
        <View style={styles.centered} accessibilityRole="text" accessibilityLabel={`${t('files.missingFileTitle')}, ${props.path}`}>
            <Ionicons name="document-text-outline" size={34} color={theme.colors.textSecondary} />
            <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600', textAlign: 'center', ...Typography.default('semiBold') }}>
                {t('files.missingFileTitle')}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19, ...Typography.default() }}>
                {t('files.missingFileBody')}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center', ...Typography.mono() }}>
                {props.path}
            </Text>
            <View style={styles.actions}>
                <Pressable
                    onPress={copyPath}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.copyPath')}
                    style={({ pressed }) => [styles.button, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }]}
                >
                    <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={16} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '600', ...Typography.default('semiBold') }}>
                        {copied ? t('common.copied') : t('files.copyPath')}
                    </Text>
                </Pressable>
                <Pressable
                    onPress={props.onOpenFolder}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.openFolder')}
                    style={({ pressed }) => [styles.button, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }]}
                >
                    <Ionicons name="folder-open-outline" size={16} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '600', ...Typography.default('semiBold') }}>
                        {t('files.openFolder')}
                    </Text>
                </Pressable>
                <Pressable
                    onPress={props.onBack}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.back')}
                    style={({ pressed }) => [styles.button, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh }]}
                >
                    <Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '600', ...Typography.default('semiBold') }}>
                        {t('common.back')}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 28,
        gap: 10,
    },
    actions: {
        marginTop: 6,
        gap: 8,
        alignItems: 'stretch',
    },
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 8,
        minHeight: 40,
    },
});
