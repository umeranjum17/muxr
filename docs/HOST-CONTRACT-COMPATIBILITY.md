# Host/client contract compatibility

The mobile client and host share `packages/contract/src/requests.ts`. Release candidates must not ship a request type the immutable host release cannot dispatch.

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

Unknown request types return the structured `host-contract-mismatch` code rather than a JavaScript handler error. Provider-specific features live behind plugins and do not add host request types.
