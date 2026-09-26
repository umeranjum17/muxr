# Relay runtime

`relay.ts` serves the self-hosted control surface and delegates authenticated sockets, streams, push and host routing to `@byokit/relay`. `routing/infrastructure/linkRelay.ts` persists byokit's host registry and push subscriptions in private files. The muxr relay has no envelope, ticket, replay buffer, socket router or synthetic request path.

The owner mint secret admits this machine's link host and authorizes shared-relay enrolment. `admission/infrastructure/machineAuthority.ts` keeps the separate owner-created, Ed25519-proven machine enrolment and scoped administrative credential; the proof binds the machine's byokit host key, so status and revocation target the same link identity. Devices authenticate to the host over Noise IK, not to the relay. `httpJson.ts` bounds the JSON control-plane body; `relay.ts` retains the web origin/CSP and LAN discovery policies.
