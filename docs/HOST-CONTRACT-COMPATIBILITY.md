# Host/client contract compatibility

The mobile client and host share `packages/contract/src/control-plane/domain/requests.ts`. Release candidates must not ship a request type the immutable host release cannot dispatch.

The compatibility gate is:

```bash
node scripts/diagnostics/application/checkHostContract.mjs <full-candidate-commit> ~/.muxr/releases/host/<full-host-commit>
```

CI also runs `scripts/diagnostics/application/checkPluginBridge.mjs`, which only asserts those five
types exist in `RequestMap` (no host release dir required).

It fails closed unless:

- both inputs identify exact full commits;
- the host release metadata and checksums verify;
- every client request type has a built host handler;
- the immutable plugin bridge (`plugin.list`, `plugin.manifest`, `plugin.approve`, `plugin.invoke`, `plugin.call`) exists on both sides.

Unknown request types return the structured `host-contract-mismatch` code rather than a JavaScript handler error. Provider-specific features live behind plugins; muxr's own product features, such as realtime voice, add typed host request types that the client and host must both ship.

## Control protocol handshake

The app and the host also agree on a control protocol version, so either can ship without the other. On every connect the app asks `machine.hello`; the host answers with its `protocol` and the `capabilityRange` of versions it still serves (`CONTROL_PROTOCOL_RANGE` in `packages/contract/src/control-plane/domain/envelope.ts`). The app opens the link only when that range overlaps its own. Otherwise it stops and says which side to update. A host too old to answer is treated as protocol 1. Raise `max` when a side learns a new protocol, and `min` only when it drops an old one.
