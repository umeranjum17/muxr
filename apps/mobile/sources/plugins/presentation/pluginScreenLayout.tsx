import * as React from 'react';
import { useWindowDimensions } from 'react-native';

const ScreenWidthContext = React.createContext<number | undefined>(undefined);

export function ScreenWidthProvider({
    width,
    children,
}: {
    width: number | undefined;
    children: React.ReactNode;
}) {
    return <ScreenWidthContext.Provider value={width}>{children}</ScreenWidthContext.Provider>;
}

export function useScreenContentWidth(): number {
    const measured = React.useContext(ScreenWidthContext);
    const { width } = useWindowDimensions();
    return measured ?? width;
}
