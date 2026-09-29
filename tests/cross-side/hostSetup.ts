// The host's setup commands, kept apart from `host.ts` because loading them
// reads the environment: a test that sets up its lab home first imports this
// dynamically.
export { linkPair, machineIdentity, machineLinkUrl, readSelfhostState } from '../../scripts/setup/index.mjs';
