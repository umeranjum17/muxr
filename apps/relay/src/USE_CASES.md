# Relay use cases

HTTP and WebSocket handlers in `relay.ts` / `httpHandlers.ts` are adapters.

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Admit a socket | `admission/application/admitSocket.ts` | Peer Identity, Ticket, loopback | WebSocket upgrade |
| Pair a device to an account | `admission/application/pairMachine.ts` | Pairing rendezvous (sealed blob only) | `POST /v1/auth/account/request`, `.../response` |
| Route an envelope | `routing/application/routeEnvelope.ts` | Envelope route (never opens payload) | authenticated WebSocket frames |

Loopback query-string admission and `machinetok_` stay live for the local harness and probe. Display names never admit a socket.
