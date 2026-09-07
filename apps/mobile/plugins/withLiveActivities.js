const { withInfoPlist, withXcodeProject } = require('@expo/config-plugins');

const NAME = 'HerdLiveActivity';
const unquote = (value) => String(value ?? '').replace(/^"|"$/g, '');

/** Also used to keep the checked-in project consistent with Expo prebuild. */
function integrateLiveActivity(project, bundleIdentifier) {
    const targets = project.pbxNativeTargetSection();
    const app = Object.entries(targets).find(([key, value]) => !key.endsWith('_comment')
        && unquote(value.productType) === 'com.apple.product-type.application');
    if (!app) throw new Error('Live Activities require an application target');
    let extension = Object.entries(targets).find(([key, value]) => !key.endsWith('_comment')
        && unquote(value.name) === NAME);
    if (!extension) {
        const target = project.addTarget(NAME, 'app_extension', NAME, `${bundleIdentifier}.activity`);
        extension = [target.uuid, target.pbxNativeTarget];
        project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
        project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
        project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
        const group = project.addPbxGroup([], NAME);
        project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    }
    const group = Object.entries(project.hash.project.objects.PBXGroup).find(([key, value]) =>
        !key.endsWith('_comment') && unquote(value.name) === NAME);
    for (const source of [
        '../modules/voice-overlay/ios/HerdActivityAttributes.swift',
        '../modules/voice-overlay/ios/HerdLiveActivityIntents.swift',
        '../widgets/HerdLiveActivity/HerdLiveActivityWidget.swift',
    ]) {
        if (!project.hasFile(source)) project.addSourceFile(source, { target: extension[0] }, group[0]);
    }
    const configurations = project.pbxXCBuildConfigurationSection();
    const lists = project.pbxXCConfigurationList();
    const appConfigurations = lists[app[1].buildConfigurationList].buildConfigurations;
    for (const reference of lists[extension[1].buildConfigurationList].buildConfigurations) {
        const configuration = configurations[reference.value];
        const matching = appConfigurations.find((item) => unquote(configurations[item.value].name) === unquote(configuration.name));
        const parent = configurations[matching.value].buildSettings;
        Object.assign(configuration.buildSettings, {
            INFOPLIST_FILE: '"../widgets/HerdLiveActivity/Info.plist"',
            PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}.activity"`,
            SWIFT_VERSION: '5.9',
            SWIFT_ACTIVE_COMPILATION_CONDITIONS: '"$(inherited) HERD_WIDGET_EXTENSION"',
            IPHONEOS_DEPLOYMENT_TARGET: '16.4',
            TARGETED_DEVICE_FAMILY: '"1,2"',
            APPLICATION_EXTENSION_API_ONLY: 'YES',
            GENERATE_INFOPLIST_FILE: 'NO',
            CODE_SIGN_STYLE: 'Automatic',
            SKIP_INSTALL: 'YES',
            MARKETING_VERSION: parent.MARKETING_VERSION || '1.0',
            CURRENT_PROJECT_VERSION: parent.CURRENT_PROJECT_VERSION || '1',
            SWIFT_OPTIMIZATION_LEVEL: unquote(configuration.name) === 'Debug' ? '"-Onone"' : '"-O"',
        });
        if (parent.DEVELOPMENT_TEAM) configuration.buildSettings.DEVELOPMENT_TEAM = parent.DEVELOPMENT_TEAM;
    }
    // node-xcode leaves optional fields undefined on new objects; its writer
    // otherwise serializes a literal "undefined" group path into the project.
    for (const section of Object.values(project.hash.project.objects)) {
        for (const object of Object.values(section)) {
            if (object && typeof object === 'object') {
                for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];
            }
        }
    }
    return project;
}

module.exports = (config) => {
    config = withInfoPlist(config, (mod) => {
        mod.modResults.NSSupportsLiveActivities = true;
        return mod;
    });
    return withXcodeProject(config, (mod) => {
        integrateLiveActivity(mod.modResults, mod.ios.bundleIdentifier);
        return mod;
    });
};
module.exports.integrateLiveActivity = integrateLiveActivity;
