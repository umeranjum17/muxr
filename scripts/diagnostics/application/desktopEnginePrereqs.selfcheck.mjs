#!/usr/bin/env node
/**
 * Pins the desktop engine gate's own decision: with every native prerequisite
 * present the suite must select the real `cargo test` run, and with one missing
 * it must print a loud skip that names that prerequisite and how to install it.
 *
 * The probes are injected, so this proves the decision the suite makes rather
 * than what this particular machine happens to have installed.
 */
import assert from 'node:assert/strict';

import { DESKTOP_ENGINE_PREREQUISITES, desktopEnginePlan } from './desktopEnginePrereqs.mjs';

assert.ok(DESKTOP_ENGINE_PREREQUISITES.length > 0, 'the gate must have prerequisites to check');

assert.deepEqual(
    desktopEnginePlan(() => true),
    { run: true },
    'every prerequisite present must select the real cargo run',
);

for (const absent of DESKTOP_ENGINE_PREREQUISITES) {
    const plan = desktopEnginePlan((command, args) => (
        command !== absent.command[0] || JSON.stringify(args) !== JSON.stringify(absent.command[1])
    ));
    assert.equal(plan.run, false, `${absent.name} missing must not select the cargo run`);
    assert.match(plan.message, /^SKIP/, 'the skip must be readable as a skip');
    assert.ok(plan.message.includes(absent.name), `the skip must name ${absent.name}`);
    assert.ok(plan.message.includes(absent.install), `the skip must say how to install ${absent.name}`);
    assert.match(plan.message, /not a pass/, 'the skip must not be readable as a pass');
}

const twoMissing = desktopEnginePlan((command, args) => (
    JSON.stringify([command, args]) !== JSON.stringify(DESKTOP_ENGINE_PREREQUISITES[0].command)
    && JSON.stringify([command, args]) !== JSON.stringify(DESKTOP_ENGINE_PREREQUISITES[1].command)
));
assert.match(twoMissing.message, /^SKIP/, 'two missing prerequisites still skip');
assert.ok(twoMissing.message.includes(DESKTOP_ENGINE_PREREQUISITES[0].name));
assert.ok(twoMissing.message.includes(DESKTOP_ENGINE_PREREQUISITES[1].name));

process.stdout.write('desktop engine prerequisite detector: ok\n');
