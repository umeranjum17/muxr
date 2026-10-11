import { Redirect } from 'expo-router';
import { useLocalSetting } from '@/catalog/store';
import { DecoderStatsScreen } from '@/desktop/presentation/DecoderStatsScreenLoader';

/**
 * Developer-only decoder probe. It is reachable through the machine screen's
 * developer section, and a direct link while the developer flag is off lands
 * on Home instead: the release UI never opens it.
 */
export default function DesktopDecoderDebugScreen() {
    const devModeEnabled = useLocalSetting('devModeEnabled');
    if (!devModeEnabled) return <Redirect href="/" />;
    return <DecoderStatsScreen />;
}
