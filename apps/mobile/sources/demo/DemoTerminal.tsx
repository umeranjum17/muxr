import * as React from 'react';
import { Text, View } from 'react-native';

/** Native fallback: the replay transcript as plain monospace lines. */
export function DemoTerminal({ lines }: { lines: string[]; live: boolean }) {
    return (
        <View>
            {lines.map((line, index) => (
                <Text key={index} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                    {line.replace(/\x1b\[[0-9;]*m/g, '')}
                </Text>
            ))}
        </View>
    );
}
