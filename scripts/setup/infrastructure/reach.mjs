// The one door from setup to @byokit/reach. The kit depends on the phone's mDNS
// library, which pulls in all of React Native, so the packed CLI must not install
// it: pack.mjs swaps this file for a bundle of the kit's Node code.
export { inspectServe, serve, SERVE_OWNED_ERROR, tailscaleName, tailscaleState, tailscaleStatus, unserve } from '@byokit/reach';
