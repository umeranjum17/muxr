# Relay use cases

| Capability | Owner | Adapter |
|---|---|---|
| Link host enrolment, Noise IK routing, stream and push registrations | `@byokit/relay` | `routing/infrastructure/linkRelay.ts`, mounted by `relay.ts` |
| Shared self-host machine enrolment and revocation | `admission/infrastructure/machineAuthority.ts` | Owner and machine-scoped HTTP routes in `relay.ts` |
| PWA static client, Origin/CSP, LAN advertisement | `relay.ts`, `@byokit/reach` | HTTP and mDNS |

The relay does not decrypt or interpret device messages. A device grant is checked by the host, not a muxr relay ticket.
