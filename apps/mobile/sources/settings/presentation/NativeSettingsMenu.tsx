import * as React from 'react';
import { Platform } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu.types';


const NativeSettingsMenuImpl = Platform.select<React.ComponentType<NativeSettingsMenuProps>>({
    ios: require('./NativeSettingsMenu.ios').NativeSettingsMenu,
    android: require('./NativeSettingsMenu.android').NativeSettingsMenu,
    default: require('./NativeSettingsMenu.web').NativeSettingsMenu,
}) ?? require('./NativeSettingsMenu.web').NativeSettingsMenu;

export function NativeSettingsMenu(props: NativeSettingsMenuProps) {
    return <NativeSettingsMenuImpl {...props} />;
}
