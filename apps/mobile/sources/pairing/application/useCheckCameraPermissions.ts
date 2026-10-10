import { useCameraPermissions } from "expo-camera";
import { Platform } from "react-native";

export function useCheckScannerPermissions(): () => Promise<boolean> {
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();

    return async () => {
        if (Platform.OS === 'android') {
            // adroid uses google code scanner which doesn't need permissions
            return true;
        }

        if (cameraPermission?.granted) return true;
        // Still loading, or not granted yet: asking resolves either without a
        // second tap, so a Scan pressed right after the screen opens still opens.
        return (await requestCameraPermission()).granted;
    }
}