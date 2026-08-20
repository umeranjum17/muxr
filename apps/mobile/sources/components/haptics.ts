import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

export function hapticsError() {
    if (Platform.OS === 'web') return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

export function hapticsLight() {
    if (Platform.OS === 'web') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export function hapticsSelection() {
    if (Platform.OS === 'web') return;
    Haptics.selectionAsync();
}

export function hapticsSuccess() {
    if (Platform.OS === 'web') return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}
