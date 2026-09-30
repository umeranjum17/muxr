# BYOKit batch 2 security coverage handoff

For the PR body, retain this mapping of focused executable security checks.
These are automated checks, not proof of physical notification delivery or live app-link handling.

| Security rejection | Executable coverage |
| --- | --- |
| Tampered device grant ciphertext/signature, wrong pinned machine authority, wrong device key/id, expired grants, broad control authority on peer grants | `packages/crypto/src/selfCheck.ts` |
| Redirected peer descriptors and excessive descriptor lifetime | `packages/crypto/src/selfCheck.ts` |
| Tampered peer install bundle ciphertext/signature and wrong pinned target authority | `packages/crypto/src/selfCheck.ts` (extended in this phase) |
| Unsafe peer shell operations, invalid broker capabilities and unknown methods | `apps/host/src/peer/application/peerFlow.test.ts` |
| Malformed native offers, misleading locator userinfo and extra redirect parameters | `tests/cross-side/pairingString.spec.ts` |
| Wrong-key notice fallback and unsafe credential/path titles absent from decrypted notice data | `scripts/diagnostics/application/linkPush.integration.test.ts` |

Focused results: crypto self-check passed; pairing-string checks passed (3 tests);
push flow passed (2 tests); peer prepare/authorize/install/prompt/revoke flow passed
(1 selected test). The initial runtime-loading failures were missing generated
package and CLI domain files, resolved with esbuild runtime transpilation. A peer
broker socket path exceeded the Unix limit beneath this long worktree path;
the same flow passed with an owned short scratch directory and private
HOME/XDG/MUXR_HOME folders. Generated runtime files and scratch data were removed.

Mutation proof: disabling install-bundle signature verification in the emitted
runtime made the new tampered-signature assertion fail with “Missing expected
exception.” Restoring verification made the crypto self-check pass.

Known gaps for captain testing: actual native/PWA notification delivery and taps,
and Tailscale Serve ownership preservation plus unavailable/ambiguous Serve state.
Push tests capture Expo sends and simulate service-worker clients. No physical
push credentials or real delivery targets were supplied; they remain out of scope
under the recorded conditional acceptance. No live Tailscale mappings or default
Herdr lifecycle were changed. Broad regression, CI and PR creation remain with
the outer executor.
