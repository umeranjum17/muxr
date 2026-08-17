const { execFileSync } = require('node:child_process');
const { withAndroidManifest } = require('@expo/config-plugins');


const variant = process.env.APP_ENV || 'development';
if (!['development', 'preview', 'production'].includes(variant)) {
    throw new Error(`APP_ENV must be development, preview, or production; received ${variant}`);
}
const name = {
    development: 'muxr (dev)',
    preview: 'muxr (preview)',
    production: 'muxr',
}[variant];
const PRODUCTION_APP_ID = 'com.trymuxr.app';
const configuredAppId = process.env.MUXR_APP_ID_BASE?.trim();
if (variant === 'production' && configuredAppId !== undefined && configuredAppId !== PRODUCTION_APP_ID) {
    throw new Error(`MUXR_APP_ID_BASE is permanent and must be ${PRODUCTION_APP_ID}`);
}
const appIdBase = variant === 'production' ? PRODUCTION_APP_ID : configuredAppId || 'app.muxr.local';
const bundleId = variant === 'production' ? appIdBase : `${appIdBase}.${variant === 'development' ? 'dev' : 'preview'}`;
const publicBaseUrl = process.env.MUXR_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
if (variant === 'production' && publicBaseUrl === undefined) {
    throw new Error('MUXR_PUBLIC_BASE_URL is required for production publishing');
}
let publicHost;
if (publicBaseUrl !== undefined) {
    const parsedPublicUrl = URL.canParse(publicBaseUrl) ? new URL(publicBaseUrl) : undefined;
    if (parsedPublicUrl === undefined || parsedPublicUrl.origin !== publicBaseUrl || (variant === 'production' && parsedPublicUrl.protocol !== 'https:')) {
        throw new Error('MUXR_PUBLIC_BASE_URL must be an origin-only absolute HTTPS URL for production');
    }
    publicHost = parsedPublicUrl.hostname;
}
const easProjectId = process.env.MUXR_EAS_PROJECT_ID?.trim();
const distribution = process.env.MUXR_DISTRIBUTION?.trim() || 'store';
if (!['store', 'direct'].includes(distribution)) {
    throw new Error(`MUXR_DISTRIBUTION must be store or direct; received ${distribution}`);
}
if (distribution === 'direct' && variant === 'production' && publicBaseUrl === undefined) {
    throw new Error('Direct distribution requires MUXR_PUBLIC_BASE_URL');
}
const consoleLoggingDefault = {
    development: true,
    preview: true,
    production: false,
}[variant];

function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function loadBuildMetadata() {
    const commitSha =
        process.env.MUXR_BUILD_COMMIT_SHA ||
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        process.env.MUXR_BUILD_COMMIT_TIMESTAMP ||
        (commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']));

    return {
        commitSha,
        commitTimestamp,
    };
}

const buildMetadata = loadBuildMetadata();

// Cleartext stays on for every variant: self-host relays use ws:// on LAN/
// Tailscale/SSH-forward addresses that no network-security-config can enumerate.
// Every muxr payload is v2 E2EE ciphertext regardless of transport; the only
// cleartext secret is the one-time pairing claim on a trusted LAN (documented).
const withDevelopmentCleartext = (config) => withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application?.[0];
    if (application?.$) application.$['android:usesCleartextTraffic'] = 'true';
    return result;
});

// expo-audio is used only for microphone permission/session setup. Its optional
// background playback service would add a second Play-declared foreground
// service type that muxr never starts.
const withMinimalAudioManifest = (config) => withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest['uses-permission'] = (manifest['uses-permission'] ?? []).filter(
        (entry) => entry.$?.['android:name'] !== 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    );
    const application = manifest.application?.[0];
    if (application) {
        application.service = (application.service ?? []).filter(
            (entry) => entry.$?.['android:name'] !== 'expo.modules.audio.service.AudioControlsService',
        );
    }
    return result;
});

export default {
    expo: {
        name,
        slug: "muxr",
        version: "0.1.4",
        runtimeVersion: "1",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: "muxr",
        userInterfaceStyle: "automatic",
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            ...(publicHost ? { associatedDomains: [`applinks:${publicHost}`] } : {}),
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                // ATS:
                // - NSAllowsLocalNetworking: lets HTTP fetches reach LAN
                //   addresses (e.g. self-hosted server at 192.168.x.y) without
                //   forcing TLS. Production cloud server is HTTPS, so the
                //   default policy still applies there.
                // - In dev/preview only, allow arbitrary HTTP loads so a
                //   developer pointing the app at their machine doesn't have
                //   to ship a TLS cert just to test attachment uploads.
                NSAppTransportSecurity: variant === 'production'
                    ? { NSAllowsLocalNetworking: true }
                    : { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: true }
            },
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                monochromeImage: "./sources/assets/images/icon-monochrome.png",
                backgroundColor: "#000000"
            },
            permissions: [
                "android.permission.RECORD_AUDIO",
                "android.permission.MODIFY_AUDIO_SETTINGS",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.POST_NOTIFICATIONS",
                "android.permission.POST_PROMOTED_NOTIFICATIONS",
                "android.permission.FOREGROUND_SERVICE",
                "android.permission.FOREGROUND_SERVICE_MICROPHONE",
            ],
            blockedPermissions: [
                "android.permission.ACTIVITY_RECOGNITION",
                // Not using external storage/media access for now — blocks Google Play photo/video permission declaration
                "android.permission.READ_EXTERNAL_STORAGE",
                "android.permission.WRITE_EXTERNAL_STORAGE",
                "android.permission.READ_MEDIA_IMAGES",
                "android.permission.READ_MEDIA_VIDEO",
                "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
                "android.permission.SYSTEM_ALERT_WINDOW",
            ],
            package: bundleId,
            ...(publicHost ? {
                intentFilters: [{
                    action: 'VIEW',
                    autoVerify: true,
                    data: [{ scheme: 'https', host: publicHost, pathPrefix: '/pair' }],
                    category: ['BROWSABLE', 'DEFAULT'],
                }],
            } : {}),
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            withDevelopmentCleartext,
            withMinimalAudioManifest,
            require("./plugins/withEinkCompatibility.js"),
            require("./plugins/withZeroconf.js"),
            require("./plugins/withAppActions.js"),
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-updates",
            "expo-asset",
            "expo-localization",
            "expo-mail-composer",
            "expo-secure-store",
            "expo-web-browser",
            "@more-tech/react-native-libsodium",
            "@config-plugins/react-native-webrtc",
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan pairing QR codes.",
                    recordAudioAndroid: false
                }
            ],
            [
                "expo-notifications",
                {
                    "enableBackgroundRemoteNotifications": true,
                    "icon": "./sources/assets/images/icon-notification.png"
                }
            ],
            [
                'expo-splash-screen',
                {
                    ios: {
                        backgroundColor: "#F2F2F7",
                        dark: {
                            backgroundColor: "#000000",
                        }
                    },
                    android: {
                        image: "./sources/assets/images/splash-android-light.png",
                        backgroundColor: "#F5F5F5",
                        dark: {
                            image: "./sources/assets/images/splash-android-dark.png",
                            backgroundColor: "#000000",
                        }
                    }
                }
            ]
        ],
        experiments: {
            typedRoutes: false
        },
        extra: {
            ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
            router: {
                root: "./sources/app"
            },
            app: {
                publicBaseUrl,
                directDistribution: distribution === 'direct',
                consoleLoggingDefault,
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
            }
        }
    }
};
