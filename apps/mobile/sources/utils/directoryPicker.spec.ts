import { describe, expect, it } from 'vitest';
import { folderKey, wherePlaces } from './directoryPicker';

describe('New agent Where', () => {
    it('offers one folder once and marks it as the only choice', () => {
        // The desk reports the open workspace without a slash; the recent cwd and
        // the typed value carry one. They are one folder, so one row, one mark.
        const places = wherePlaces(['/tmp/mi/home/projects', undefined], ['/tmp/mi/home/projects/', '/tmp/mi/home/other']);
        expect(places).toEqual([{ path: '/tmp/mi/home/projects', note: 'Open' }, { path: '/tmp/mi/home/other' }]);
        const value = '/tmp/mi/home/projects/';
        expect(places.filter((place) => folderKey(place.path) === folderKey(value))).toHaveLength(1);
        expect(folderKey('/')).toBe('/');
    });
});
