// A second-Claude-account lab on a fake-Herdr stack, for an iOS Simulator. See accounts-ios.md.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startFakeStack } from './perf/lib/fakeStack.mjs';

// Lab stand-in for the `claude` CLI: answers the status/login calls muxr and BYOKit make
// from the account folder. Never a real account.
const CLAUDE = `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ "$1" = auth ] && [ "$2" = status ]; then
  [ -f "$dir/lab-account.json" ] && { cat "$dir/lab-account.json"; exit 0; }
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
if [ "$1" = auth ] && [ "$2" = login ]; then
  mkdir -p "$dir"
  printf '{"loggedIn":true,"authMethod":"claude.ai","email":"umer.work@example.com","subscriptionType":"max"}\\n' > "$dir/lab-account.json"
  exit 0
fi
exec sleep 86400
`;
const stack = await startFakeStack({
    transport: 'loopback', panes: 2, agents: 2, titleChurnHz: 0,
    setupHome(home) {
        const bin = join(home, 'lab-bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, 'claude'), CLAUDE);
        chmodSync(join(bin, 'claude'), 0o755);
        // The computer's own sign-in: the "found" Umer the new account sits next to.
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude/lab-account.json'), '{"loggedIn":true,"authMethod":"claude.ai","email":"umer@example.com","subscriptionType":"max"}\n');
        return { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
    },
});
let pairing;
// A standalone run has no command scope, so nothing else stops the stack.
const stop = () => { pairing?.release(); stack.stop(); process.exit(0); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
// Each SIGUSR1 mints one pairing link (5 minutes), one per simulator.
const mint = async () => {
    pairing?.release();
    pairing = await stack.mintPairing();
    console.log(`pair link: muxr://pair#${pairing.code}`);
};
process.on('SIGUSR1', () => void mint().catch((error) => console.error(error)));
console.log(`lab ready: relay 127.0.0.1:${stack.relayPort}, pid ${process.pid}`);
await mint();
