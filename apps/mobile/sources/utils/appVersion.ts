import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { loadAppConfig } from '@/catalog/infrastructure/appConfig';
import { appBuild, applicationVersion } from './versionStatus';

/** The installed binary owns the native version; Expo config is the web fallback. */
export function getAppVersion(): string {
    return applicationVersion(Application.nativeApplicationVersion, Constants.expoConfig?.version);
}

export function getAppBuildNumber(): string | undefined {
    return Application.nativeBuildVersion || undefined;
}

/** The running build as people read it: `0.2.13`, `0.2.14-nightly.1.1`, `0.2.13-dev`. */
export function getAppBuild(): ReturnType<typeof appBuild> {
    const config = loadAppConfig();
    return appBuild(getAppVersion(), config.releaseVersion, config.buildVariant);
}
