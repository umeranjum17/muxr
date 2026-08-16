import { Platform, Linking, PermissionsAndroid } from 'react-native';
import { Modal } from '@/modal';
import { AudioModule, setAudioModeAsync } from 'expo-audio';

export interface MicrophonePermissionResult {
  granted: boolean;
  canAskAgain?: boolean;
}

/**
 * CRITICAL: Request microphone permissions BEFORE starting any audio session
 * Without this, first voice session WILL fail on iOS/Android
 *
 * Uses expo-audio (SDK 52+) - expo-av is deprecated
 */
let pendingMicrophonePermission: Promise<MicrophonePermissionResult> | null = null;
let pendingNotificationPermission: Promise<boolean> | null = null;
let initialNotificationPromptAttempted = false;

export function requestMicrophonePermission(): Promise<MicrophonePermissionResult> {
  if (pendingMicrophonePermission !== null) return pendingMicrophonePermission;
  pendingMicrophonePermission = (async () => {
    // Android removes tasks that launch permission activities too rapidly.
    if (pendingNotificationPermission !== null) await pendingNotificationPermission;
    return requestMicrophonePermissionOnce();
  })().finally(() => {
    pendingMicrophonePermission = null;
  });
  return pendingMicrophonePermission;
}

async function requestMicrophonePermissionOnce(): Promise<MicrophonePermissionResult> {
  try {
    if (Platform.OS === 'web') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        return { granted: true };
      } catch (error: any) {
        console.error('Web microphone permission denied:', error);
        return { granted: false, canAskAgain: error.name !== 'NotAllowedError' };
      }
    }

    // API 36 can destroy the app task when repeated permission activities are
    // launched rapidly. Never ask Android again after it already granted mic.
    const current = await AudioModule.getRecordingPermissionsAsync();
    const result = current.granted ? current : await AudioModule.requestRecordingPermissionsAsync();
    if (!result.granted) return { granted: false, canAskAgain: result.canAskAgain };

    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldRouteThroughEarpiece: false,
        interruptionMode: 'doNotMix',
      });
    } catch (error) {
      // Permission is still granted; recorder setup reports audio-mode failures.
      console.warn('Could not configure recording audio mode:', error);
    }
    return { granted: true, canAskAgain: result.canAskAgain };
  } catch (error) {
    console.error('Error requesting microphone permission:', error);
    return { granted: false };
  }
}

/** Android 13+ hides the herd tray and foreground-service notification until granted. */
export function requestNotificationPermission(userInitiated = true): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return Promise.resolve(true);
  if (pendingNotificationPermission !== null) return pendingNotificationPermission;
  pendingNotificationPermission = (async () => {
    if (pendingMicrophonePermission !== null) await pendingMicrophonePermission;
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(permission)) return true;
    if (!userInitiated && initialNotificationPromptAttempted) return false;
    if (!userInitiated) initialNotificationPromptAttempted = true;
    return await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
  })().finally(() => {
    pendingNotificationPermission = null;
  });
  return pendingNotificationPermission;
}

/**
 * Check current microphone permission status without prompting
 */
export async function checkMicrophonePermission(): Promise<MicrophonePermissionResult> {
  try {
    if (Platform.OS === 'web') {
      // Web: Check permission status if available
      if ('permissions' in navigator && 'query' in navigator.permissions) {
        try {
          const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          return { granted: result.state === 'granted' };
        } catch {
          // Permission API not supported or microphone permission not queryable
          // We'll have to request to know
          return { granted: false, canAskAgain: true };
        }
      }
      return { granted: false, canAskAgain: true };
    } else {
      // iOS and Android: Use expo-audio (SDK 52+)
      const result = await AudioModule.getRecordingPermissionsAsync();
      return { granted: result.granted, canAskAgain: result.canAskAgain };
    }
  } catch (error) {
    console.error('Error checking microphone permission:', error);
    return { granted: false };
  }
}

/**
 * Show appropriate error message when permission is denied
 */
export function showMicrophonePermissionDeniedAlert(canAskAgain: boolean = false) {
  const title = 'Microphone Access Required';
  const message = canAskAgain
    ? 'muxr needs access to your microphone for voice chat. Please grant permission when prompted.'
    : 'muxr needs access to your microphone for voice chat. Please enable microphone access in your device settings.';

  if (Platform.OS === 'web') {
    // Web: Show browser-specific instructions
    Modal.alert(
      title,
      'Please allow microphone access in your browser settings. You may need to click the lock icon in the address bar and enable microphone permission for this site.',
      [{ text: 'OK' }]
    );
  } else {
    Modal.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open Settings',
        onPress: () => {
          // Opens app settings on iOS/Android
          Linking.openSettings();
        }
      }
    ]);
  }
}
