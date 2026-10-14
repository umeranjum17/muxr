import { useWindowDimensions } from 'react-native';

// Narrow when width/fontScale < 200: covers 270 dp and 208 dp at font 2.0,
// and a 393 dp phone at font 2.0 (196.5), which is intended.
export function useCompactWindow(): boolean {
    const { width, fontScale } = useWindowDimensions();
    return width / fontScale < 200;
}
