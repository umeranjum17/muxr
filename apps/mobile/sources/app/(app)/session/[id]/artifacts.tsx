import * as React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';

import { SharedArtifactsTimeline } from '@/components/SharedArtifactsTimeline';

export default function SharedArtifactsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <>
        <Stack.Screen options={{ title: 'Shared Artifacts' }} />
        <SharedArtifactsTimeline key={id} sessionId={id} />
    </>;
}
