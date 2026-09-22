import * as React from 'react';
import { PRIMITIVE_SPECS, type PluginPrimitive } from '@muxr/contract';
import type { PrimitiveProps } from '../domain/primitiveTypes';
import { CapabilityButton } from './primitives/CapabilityButton';
import { CollectionView } from './primitives/CollectionView';
import { DictateButton } from '@/components/DictateButton';
import { TreeSheet } from './primitives/TreeSheet';
import { ItemList } from './primitives/ItemList';


type PrimitiveRenderer = (props: PrimitiveProps) => React.ReactNode;

function hasContext(props: PrimitiveProps): boolean {
    const spec = PRIMITIVE_SPECS[props.contribution.primitive];
    return spec.requires.every((key) => key in props.context);
}

/** Platform renderers consume one checked context object; no any/partial union. */
const registry: Record<PluginPrimitive, PrimitiveRenderer> = {
    'item-list': (props) => <ItemList {...props} />,
    collection: (props) => <CollectionView {...props} />,
    'icon-button': (props) => <CapabilityButton {...props} />,
    // The product mounts the one realtime overlay in _layout.tsx. Declaring
    // this primitive is how a plugin asks for speech.wake/voice.start, and the
    // gate must keep seeing it; rendering here would paint a second bubble.
    'realtime-session-overlay': () => null,
    'tree-sheet': (props) => <TreeSheet {...props} />,
    dictate: (props) => <DictateButton context={props.context as { getText: () => string; setText: (text: string) => void }} />,
};

export function renderPrimitive(props: PrimitiveProps): React.ReactNode {
    if (!hasContext(props)) {
        console.warn(`[plugin ${props.pluginId}] primitive ${props.contribution.primitive} missing required slot context`);
        return null;
    }
    return registry[props.contribution.primitive](props);
}
