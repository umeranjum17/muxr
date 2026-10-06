import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScopedTheme, StyleSheet } from 'react-native-unistyles';
import { AddAccountSheet, NameAccountSheet, Notice, SignInBanner } from './AccountFlows';
import { MoveSheet } from './MoveAccount';

/** Mounted once beside the navigator: the sheets and notices of the account
 *  flows outlive the screen that started them. Renders nothing at rest. The
 *  notice is not chrome: it reads the app theme it lands in, so switching the
 *  theme while it is up repaints it. The sheets and the sign-in banner stay on
 *  the dark theme, because a session screen is dark whatever the app theme. */
export function PlanAccountsOverlay() {
    const insets = useSafeAreaInsets();
    return (
        <>
            <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                <ScopedTheme name="dark">
                    {/* Above the terminal's key row and composer: the sign-in still needs both. */}
                    <SignInBanner bottom={insets.bottom + 116} />
                </ScopedTheme>
                <Notice top={insets.top + 56} />
            </View>
            <AddAccountSheet />
            <NameAccountSheet />
            <ScopedTheme name="dark">
                <MoveSheet />
            </ScopedTheme>
        </>
    );
}
