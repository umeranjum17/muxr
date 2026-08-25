import { Dimensions, Platform } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { useMemo } from 'react';
import { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight } from './deviceCalculations';
import { isRunningOnMac } from './platform';

// Re-export calculation functions for use in other components
export { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight };
export const SPLIT_VIEW_MIN_WIDTH = 900;

export interface SplitViewLayoutInput {
    width: number;
    platform: typeof Platform.OS;
    isPad: boolean;
    isMac: boolean;
    deviceType: 'phone' | 'tablet';
}

export function shouldUseSplitViewLayout({
    width,
    platform,
    isPad,
    isMac,
    deviceType,
}: SplitViewLayoutInput): boolean {
    const capable = platform === 'web'
        || isMac
        || (platform === 'ios' && isPad)
        || (platform === 'android' && deviceType === 'tablet');
    return capable && width >= SPLIT_VIEW_MIN_WIDTH;
}

// Get header height based on platform, device type, and orientation (wrapper for backward compatibility)
export function getHeaderHeight(isLandscape: boolean, deviceType: 'phone' | 'tablet'): number {
    return calculateHeaderHeight({
        platform: Platform.OS,
        isLandscape,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
        deviceType: Platform.OS === 'android' ? deviceType : undefined,
        isMacCatalyst: isRunningOnMac()
    });
}

// Device type detection based on screen size and aspect ratio
export function getDeviceType(): 'phone' | 'tablet' {
    const { width, height } = Dimensions.get('screen');

    const dimensions = calculateDeviceDimensions({
        widthPoints: width,
        heightPoints: height,
        pointsPerInch: Platform.OS === 'ios' ? 163 : 160
    });

    return determineDeviceType({
        diagonalInches: dimensions.diagonalInches,
        platform: Platform.OS,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : false
    });
}

// Hook to get device type (reactive to dimension changes)
export function useDeviceType(): 'phone' | 'tablet' {
    const { width, height } = useWindowDimensions();
    
    return useMemo(() => {
        const dimensions = calculateDeviceDimensions({
            widthPoints: width,
            heightPoints: height,
            pointsPerInch: Platform.OS === 'ios' ? 163 : 160
        });

        return determineDeviceType({
            diagonalInches: dimensions.diagonalInches,
            platform: Platform.OS,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : false
        });
    }, [width, height]);
}

// Hook to detect if device is tablet
export function useIsTablet(): boolean {
    const deviceType = useDeviceType();
    return deviceType === 'tablet';
}

/** Master/detail is a window capability, not a physical-device label. */
export function useSplitViewLayout(): boolean {
    const { width } = useWindowDimensions();
    const deviceType = useDeviceType();
    return shouldUseSplitViewLayout({
        width,
        platform: Platform.OS,
        // @ts-ignore - isPad exists at runtime on iOS.
        isPad: Platform.OS === 'ios' && Platform.isPad === true,
        isMac: isRunningOnMac(),
        deviceType,
    });
}

// Hook to detect landscape orientation
export function useIsLandscape(): boolean {
    const { width, height } = useWindowDimensions();
    return width > height;
}

// Hook to get header height based on platform, device type, and orientation
export function useHeaderHeight(): number {
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    
    return useMemo(() => {
        return calculateHeaderHeight({
            platform: Platform.OS,
            isLandscape,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
            deviceType: Platform.OS === 'android' ? deviceType : undefined,
            isMacCatalyst: isRunningOnMac()
        });
    }, [isLandscape, deviceType]);
}