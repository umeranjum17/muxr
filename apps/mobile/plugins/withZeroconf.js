// Expo config plugin: permissions and iOS Bonjour declarations for react-native-zeroconf.
const { withInfoPlist, withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

module.exports = function withZeroconf(config) {
    config = withInfoPlist(config, (c) => {
        c.modResults.NSBonjourServices = ['_muxr._tcp.'];
        c.modResults.NSLocalNetworkUsageDescription = 'muxr discovers relays on your local network so you can connect without typing addresses.';
        return c;
    });
    return withAndroidManifest(config, (c) => {
        for (const permission of [
            'android.permission.ACCESS_NETWORK_STATE',
            'android.permission.ACCESS_WIFI_STATE',
            'android.permission.CHANGE_WIFI_MULTICAST_STATE',
        ]) {
            AndroidConfig.Permissions.addPermission(c.modResults, permission);
        }
        return c;
    });
};
