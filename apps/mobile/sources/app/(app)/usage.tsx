import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UsageScreen } from '@/usage';

const styles = StyleSheet.create((theme) => ({
    // One surface for the header and the list below it. A transparent header
    // over the navigator's backdrop drew a band of a different black above the
    // content, which read as empty chrome rather than as this screen.
    container: { flex: 1, backgroundColor: theme.colors.surface },
}));

/** The product Usage screen: the machine's coding-agent usage, plan limits
 *  and local activity. Served by the host's typed usage.report method. The
 *  screen draws its own header -- `usage` is registered headerShown: false --
 *  because the header's refresh control acts on the screen's own read. */
export default function UsagePage() {
    return (
        <View style={styles.container}>
            <UsageScreen />
        </View>
    );
}
