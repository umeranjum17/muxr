import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// A menu sheet keeps a 236 px floor inside 8 px margins. Narrower than that (an
// installed PWA at the largest text is a 135 px viewport) its rows give up their
// icons and chevrons, so labels wrap by word and counts stay inside the sheet.
export function SheetIcon(props: React.ComponentProps<typeof Ionicons>) {
    return useWindowDimensions().width < 252 ? null : <Ionicons {...props} />;
}
