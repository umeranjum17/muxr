import * as React from 'react';
import { Platform } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { ChoiceSheet, type Choice } from '@/components/ChoiceSheet';
import { useLocalSettingMutable } from '@/catalog/store';
import { GestureGlyph, GestureTile, StopsTile } from '@/settings/GestureGlyph';

type SwipeFingers = 'one' | 'two' | 'off';
type SwipeScope = 'working' | 'all';

const FINGERS: Record<SwipeFingers, string> = { one: 'One finger', two: 'Two fingers', off: 'Off' };
const SCOPE: Record<SwipeScope, string> = { working: 'Working agents', all: 'Every agent' };

// What a swipe does, where it stops and what it shares its fingers with,
// in the words of whichever way of swiping is chosen.
function swipeFooter(fingers: SwipeFingers, scope: SwipeScope, pinch: boolean): string {
    if (fingers === 'off') return 'Switch agents from the strip under the terminal, or from Home.';
    const parts = ['Agents follow the Live strip on Home: swipe left for the next, right for the one before.'];
    if (scope === 'working') parts.push('A swipe stops at agents working now or done in the last two minutes.');
    if (fingers === 'one') parts.push('Up and down still scrolls; hold before dragging to select text.');
    else parts.push(pinch ? 'One finger still scrolls and selects text, and spreading two fingers zooms instead.' : 'One finger still scrolls and selects text.');
    return parts.join(' ');
}

/**
 * Every gesture a terminal answers, and the ones worth a choice. Each row
 * draws its gesture; the choices draw their options on a terminal of their
 * own, so what is being picked is what will happen.
 */
export default function GesturesSettingsScreen() {
    const [fingers, setFingers] = useLocalSettingMutable('terminalSwipeFingers');
    const [scope, setScope] = useLocalSettingMutable('terminalSwipeScope');
    const [pinch, setPinch] = useLocalSettingMutable('terminalPinchZoom');
    const [keyboardDisabled] = useLocalSettingMutable('terminalKeyboardDisabled');
    const [sheet, setSheet] = React.useState<'fingers' | 'scope' | null>(null);
    const close = () => setSheet(null);
    const native = Platform.OS !== 'web';

    const fingerChoices: Choice[] = [
        { key: 'one', label: FINGERS.one, preview: <GestureTile gesture="swipe" /> },
        { key: 'two', label: FINGERS.two, preview: <GestureTile gesture="swipe-two" /> },
        { key: 'off', label: FINGERS.off, preview: <GestureTile gesture="off" /> },
    ];
    const scopeChoices: Choice[] = [
        { key: 'working', label: SCOPE.working, preview: <StopsTile everyAgent={false} /> },
        { key: 'all', label: SCOPE.all, preview: <StopsTile everyAgent /> },
    ];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Switch agents" footer={swipeFooter(fingers, scope, pinch)}>
                <Item
                    title="Swipe"
                    subtitle={FINGERS[fingers]}
                    icon={<GestureGlyph gesture={fingers === 'two' ? 'swipe-two' : 'swipe'} />}
                    onPress={() => setSheet('fingers')}
                />
                {fingers !== 'off' && (
                    <Item
                        title="Stops at"
                        subtitle={SCOPE[scope]}
                        icon={<GestureGlyph gesture="stops" />}
                        onPress={() => setSheet('scope')}
                    />
                )}
            </ItemGroup>

            <ItemGroup
                title="Text size"
                footer={pinch
                    ? 'Spread two fingers to enlarge the text and pinch to shrink it. The size is kept for every terminal, and you can also set it in Appearance.'
                    : 'Two fingers leave the text size alone. Set it in Appearance.'}
            >
                <Item
                    title="Pinch to zoom"
                    icon={<GestureGlyph gesture="pinch" />}
                    showChevron={false}
                    rightElement={<Switch accessibilityLabel="Pinch to zoom" value={pinch} onValueChange={setPinch} />}
                />
            </ItemGroup>

            <ItemGroup title="Always in the terminal" footer="Swiping in from the very edge of the screen belongs to your phone, so an agent swipe starts a little inside it.">
                <Item
                    title="Tap"
                    subtitle={native && keyboardDisabled ? 'Focuses the terminal' : 'Opens the keyboard'}
                    subtitleLines={0}
                    icon={<GestureGlyph gesture="tap" />}
                />
                <Item title="Drag up or down" subtitle="Scrolls the output" subtitleLines={0} icon={<GestureGlyph gesture="scroll" />} />
                <Item
                    title="Touch and hold"
                    subtitle={native ? 'Selects a word; keep dragging to select more. On a link, copies it.' : 'On a link, shows what you can do with it'}
                    subtitleLines={0}
                    icon={<GestureGlyph gesture="hold" />}
                />
                <Item title="Tap a link" subtitle="Asks what to do; never opens by itself" subtitleLines={0} icon={<GestureGlyph gesture="link" />} />
                <Item
                    title="Floating control"
                    subtitle="Tap for its actions, or slide to one and lift. Hold, then drag, to move it."
                    subtitleLines={0}
                    icon={<GestureGlyph gesture="control" />}
                />
                <Item title="Hold a key" subtitle="An arrow key repeats until you let go" subtitleLines={0} icon={<GestureGlyph gesture="repeat" />} />
                <Item title="Edge swipe" subtitle="Goes back" subtitleLines={0} icon={<GestureGlyph gesture="edge" />} />
            </ItemGroup>

            <ChoiceSheet
                visible={sheet === 'fingers'}
                title="Swipe between agents"
                choices={fingerChoices}
                selectedKey={fingers}
                onSelect={(key) => setFingers(key as SwipeFingers)}
                onClose={close}
            />
            <ChoiceSheet
                visible={sheet === 'scope'}
                title="A swipe stops at"
                choices={scopeChoices}
                selectedKey={scope}
                onSelect={(key) => setScope(key as SwipeScope)}
                onClose={close}
            />
        </ItemList>
    );
}
