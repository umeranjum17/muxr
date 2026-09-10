import { Stack } from 'expo-router';
import { DemoScreen } from '@/demo/DemoScreen';

export const unstable_settings = {
    headerShown: false,
};

export default function DemoRoute() {
    return (
        <>
            <Stack.Screen options={{ headerShown: false, headerTitle: 'Demo replay' }} />
            <DemoScreen />
        </>
    );
}
