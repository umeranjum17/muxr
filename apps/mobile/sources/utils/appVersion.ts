import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { applicationVersion } from './versionStatus';

/** The installed binary owns the native version; Expo config is the web fallback. */
export function getAppVersion(): string {
    return applicationVersion(Application.nativeApplicationVersion, Constants.expoConfig?.version);
}

export function getAppBuildNumber(): string | undefined {
    return Application.nativeBuildVersion || undefined;
}
