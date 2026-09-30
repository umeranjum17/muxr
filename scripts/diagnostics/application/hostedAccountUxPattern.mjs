import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function assertNoHostedAccountRoutes(routes) {
    for (const route of routes) {
        const segments = route.split('/').filter((segment) => segment !== '' && !segment.startsWith('('));
        assert.equal(segments.some((segment, index) => segment === 'settings' && segments[index + 1] === 'account'), false,
            `${route} still exposes hosted-account UX`);
    }
}

export function checkHostedAccountRoutes(appDirectory) {
    const routes = readdirSync(appDirectory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.[jt]sx?$/.test(entry.name))
        .map((entry) => join(entry.parentPath.slice(appDirectory.length), entry.name).replace(/(?:\.(?:android|ios|native|web))?\.[jt]sx?$/, ''));
    assertNoHostedAccountRoutes(routes);
}
