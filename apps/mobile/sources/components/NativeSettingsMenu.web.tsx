import * as React from 'react';
import { View } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu.types';

export function NativeSettingsMenu({ children, style }: NativeSettingsMenuProps) {
    return <View style={style}>{children}</View>;
}
