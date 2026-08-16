import * as React from 'react';
import { PRIMITIVE_SPECS, type PluginNativeContribution, type PluginNativeSlot, type PluginPrimitive } from '@muxr/contract';
import type { PluginSlotContexts } from './slotTypes';
import { CapabilityButton } from './primitives/CapabilityButton';
import { CollectionView } from './primitives/CollectionView';
import { RealtimeSessionOverlay } from './primitives/RealtimeSessionOverlay';
import { DictateButton } from './primitives/DictateButton';
import { TreeSheet } from './primitives/TreeSheet';
import { ItemList } from './primitives/ItemList';

export type PrimitiveProps = {
    pluginId: string;
    manifestHash: string;
    contribution: PluginNativeContribution;
    context: PluginSlotContexts[PluginNativeSlot];
};

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
    'realtime-session-overlay': () => <RealtimeSessionOverlay />,
    'tree-sheet': (props) => <TreeSheet {...props} />,
    dictate: (props) => <DictateButton {...props} />,
};

export function renderPrimitive(props: PrimitiveProps): React.ReactNode {
    if (!hasContext(props)) {
        console.warn(`[plugin ${props.pluginId}] primitive ${props.contribution.primitive} missing required slot context`);
        return null;
    }
    return registry[props.contribution.primitive](props);
}
