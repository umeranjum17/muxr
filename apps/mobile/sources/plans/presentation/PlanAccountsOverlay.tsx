import * as React from 'react';
import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScopedTheme, StyleSheet } from 'react-native-unistyles';
import { AddAccountSheet, NameAccountSheet, Notice, SignInBanner, useFlows } from './AccountFlows';
import { MoveSheet } from './MoveAccount';

/** Mounted once beside the navigator: the sheets and notices of the account
 *  flows outlive the screen that started them. Renders nothing at rest. What
 *  shows over a session reads the dark theme, like everything on that screen. */
export function PlanAccountsOverlay() {
    const insets = useSafeAreaInsets();
    const onSession = usePathname().startsWith('/session/');
    // A move's notice says so itself: the route changes under it mid-move.
    const overSession = useFlows((state) => state.notice?.overSession === true) || onSession;
    const notice = <Notice top={insets.top + 56} />;
    return (
        <>
            <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                <ScopedTheme name="dark">
                    {/* Above the terminal's key row and composer: the sign-in still needs both. */}
                    <SignInBanner bottom={insets.bottom + 116} />
                </ScopedTheme>
                {overSession ? <ScopedTheme name="dark">{notice}</ScopedTheme> : notice}
            </View>
            <AddAccountSheet />
            <NameAccountSheet />
            <ScopedTheme name="dark">
                <MoveSheet />
            </ScopedTheme>
        </>
    );
}
