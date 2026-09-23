import * as React from 'react';
import { Pressable, View } from 'react-native';
import { OptionSheet } from '@/components/OptionSheet';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu.types';

/**
 * Android lists the choices in the app's own option sheet. The Compose menu it
 * replaces made every cold start register @expo/ui's native module first, a
 * quarter of a second before any JavaScript ran, so package.json keeps
 * @expo/ui out of Android autolinking.
 */
export function NativeSettingsMenu({ groups, children, style, flat = false }: NativeSettingsMenuProps) {
    const [open, setOpen] = React.useState(false);
    const labelled = !flat && groups.length > 1;
    const entries = groups.flatMap((group) => group.options.map((option) => ({ group, option })));
    const selected = entries.findIndex(({ group, option }) => option.key === group.selectedKey);
    return (
        <View style={style}>
            <Pressable accessibilityRole="button" accessibilityLabel={groups[0]?.label} onPress={() => setOpen(true)}>
                {children}
            </Pressable>
            <OptionSheet
                visible={open}
                title={groups.length === 1 ? groups[0]!.label : 'Settings'}
                options={entries.map(({ group, option }, index) => ({
                    key: String(index),
                    name: labelled ? `${group.label}: ${option.label}` : option.label,
                }))}
                selectedKey={selected === -1 ? null : String(selected)}
                onSelect={(choice) => {
                    const entry = entries[Number(choice.key)];
                    entry?.group.onSelect(entry.option.key);
                }}
                onClose={() => setOpen(false)}
            />
        </View>
    );
}
