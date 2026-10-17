import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// A menu sheet keeps a 236 px floor inside 16 px margins. Narrower than this (an
// installed PWA at the largest text is a 135 px viewport) it tightens its margins
// and its rows give up their icons and chevrons, so labels wrap by word and counts
// stay inside the sheet.
export const NARROW_SHEET_WINDOW = 252;

export function SheetIcon(props: React.ComponentProps<typeof Ionicons>) {
    return useWindowDimensions().width < NARROW_SHEET_WINDOW ? null : <Ionicons {...props} />;
}
