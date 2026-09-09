import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export type NativeSettingsMenuOption = {
    key: string;
    label: string;
};

export type NativeSettingsMenuGroup = {
    key: string;
    label: string;
    systemImage?: string;
    options: NativeSettingsMenuOption[];
    selectedKey: string | null | undefined;
    onSelect: (key: string) => void;
};

export type NativeSettingsMenuProps = {
    groups: NativeSettingsMenuGroup[];
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    /** Render all options directly in the root menu instead of nesting by group. */
    flat?: boolean;
};
