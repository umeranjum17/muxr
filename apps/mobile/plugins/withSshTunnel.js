const { withPodfile } = require('expo/config-plugins');

module.exports = function withSshTunnel(config) {
    return withPodfile(config, (c) => {
        const declaration = "pod 'MuxrSSH2', :podspec => '../modules/ssh-tunnel/ios/MuxrSSH2.podspec'";
        if (!c.modResults.contents.includes(declaration)) {
            c.modResults.contents = c.modResults.contents.replace('  use_expo_modules!', `  ${declaration}\n  use_expo_modules!`);
        }
        return c;
    });
};
