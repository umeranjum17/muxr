import * as React from 'react';
import { DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import { Text, View } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu.types';

export function NativeSettingsMenu({ groups, children, style, flat = false }: NativeSettingsMenuProps) {
    return (
        <View style={style}>
            <DropdownMenu>
                <DropdownMenu.Items>
                    {groups.flatMap((group) => group.options.map((option) => (
                        <DropdownMenuItem
                            key={`${group.key}:${option.key}`}
                            onClick={() => group.onSelect(option.key)}
                        >
                            <DropdownMenuItem.Text>
                                <Text>
                                    {`${flat ? '' : `${group.label}: `}${option.key === group.selectedKey ? '✓ ' : ''}${option.label}`}
                                </Text>
                            </DropdownMenuItem.Text>
                        </DropdownMenuItem>
                    )))}
                </DropdownMenu.Items>
                <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
            </DropdownMenu>
        </View>
    );
}
