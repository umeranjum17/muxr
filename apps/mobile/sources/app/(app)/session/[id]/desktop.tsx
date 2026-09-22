import * as React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

/** Keep existing links working, but show Computer inside the actual session. */
export default function DesktopScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <Redirect href={{ pathname: '/session/[id]', params: { id, desktop: '1' } }} />;
}
