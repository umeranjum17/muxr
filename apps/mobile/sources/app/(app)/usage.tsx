import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Header } from '@/components/navigation/Header';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { UsageScreen } from '@/usage';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1 },
    headerTitle: {
        fontSize: 16,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
}));

/** The product Usage screen: the machine's coding-agent usage, plan limits
 *  and local activity. Served by the host's typed usage.report method. */
export default function UsagePage() {
    const { theme } = useUnistyles();
    const router = useRouter();
    return (
        <View style={styles.container}>
            <Header
                title={<Text style={styles.headerTitle}>{t('usage.title')}</Text>}
                headerLeft={() => <HeaderBackButton onPress={() => router.back()} label={t('plugins.goBack')} />}
                headerLeftGlass={false}
                headerShadowVisible={false}
                headerTransparent
            />
            <UsageScreen />
        </View>
    );
}
