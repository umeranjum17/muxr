import { describe, expect, it } from 'vitest';
import type { PluginAction } from '@muxr/contract';
import { asPluginItemList } from './itemListModel';

const validate = (value: unknown): PluginAction => {
    if (value === null || typeof value !== 'object' || (value as { type?: unknown }).type !== 'open-url') throw new Error('bad action');
    return value as PluginAction;
};

describe('item-list public response', () => {
    it('bounds row metadata, icons, sheet actions, and closed actions together', () => {
        const model = asPluginItemList({
            items: [{
                id: 'src/app.ts', title: 'app.ts', subtitle: 'src/app.ts', icon: 'git-compare-outline',
                metadata: [
                    { value: '+12', tone: 'positive' },
                    { value: '−3', tone: 'danger' },
                    { label: 'kind', value: 'modified' },
                    { value: 'ignored' },
                ],
                action: { type: 'open-url', url: 'https://example.com/file' },
            }, {
                id: 'src/app.ts', title: 'duplicate', action: { type: 'open-url', url: 'https://example.com/duplicate' },
            }, { id: 'bad', title: 'bad', action: { type: 'unknown' } }],
            actions: [{ id: 'review', label: 'Review', icon: 'eye-outline', action: { type: 'open-url', url: 'https://example.com' } }],
        }, validate);

        expect(model).toMatchObject({
            items: [{ id: 'src/app.ts', icon: 'git-compare-outline', metadata: [{ value: '+12', tone: 'positive' }, { value: '−3', tone: 'danger' }, { label: 'kind', value: 'modified' }] }],
            actions: [{ id: 'review', label: 'Review', icon: 'eye-outline' }],
        });
    });
});
