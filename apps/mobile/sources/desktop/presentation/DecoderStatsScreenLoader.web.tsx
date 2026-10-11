import * as React from 'react';
import { Text, View } from 'react-native';

// The probe reads the native receiver's decoder statistics; the PWA has no
// equivalent, and importing the probe here would pull the desklink desktop
// session into the eager web payload (or, shared with the terminal's lazy
// desktop, hoist it into the eager __common chunk). Web shows a short note
// instead, and never imports the screen.
export function DecoderStatsScreen(): React.JSX.Element {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
            <Text style={{ textAlign: 'center' }}>The desktop decoder probe runs in the native app.</Text>
        </View>
    );
}
