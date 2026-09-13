# Surfaces: browser and code review targets

## When to use
Use when the workflow needs a real WebView browser (ordinary HTTPS or a
host-local dev server) or a native code review anchor, instead of
terminal graphics. With muxr available and `HERDR_PANE_ID` present, use
these commands; they are the only Browser/Code entry points.

## Procedure
1. From an open terminal (so `HERDR_PANE_ID` and the cwd resolve against live
   Herdr state), open the target:
   `muxr browser open https://example.com/guide` for public HTTPS, or
   `muxr browser open http://localhost:3000/app` for a host-local app, or
   `muxr browser home` for an honest blank tab (the only non-HTTPS target).
   The host-local port, provider and worktree always come from host state —
   never type a port, provider or context on the phone, and never print one.
2. Optional flags: `--beside` or `--focus` (placement intent only),
   `--name NAME` (logical surface name), `--provider ID` (only when more than
   one surface provider is enabled; ambiguity fails visibly).
3. `muxr browser update [URL]`, `muxr browser reload` and `muxr browser close`
   act on the named surface; `muxr surface list` shows what is open.
4. `muxr code open <path[:line[:column]]>` and `muxr code diff [path]` open
   native Files/Changes/History review targets. Mode is review: opening Code
   grants no editing authority, and paths outside the resolved worktree fail.

## Pitfalls
- `HERDR_PANE_ID` is a context hint, not a credential. A stale pane id, a
  moved terminal, or an ambiguous directory fails instead of opening the
  surface in the wrong place — run from the terminal that owns the work.
- Remote plain-HTTP URLs, credentialed URLs (`user:pass@`), `file:` URLs and
  other unsupported schemes fail closed. Host-profile sessions (cookies,
  login, 2FA) stay on the explicitly labeled takeover route, never in the
  WebView.
- A launch creates or updates a visible surface and only foregrounds when the
  controlling device enabled that preference.
- No relay token, tunnel key, IDE password, internal id or capability secret
  enters agent output or environment. Replies name the logical surface only.
- A surface that is expired, closed or replaced fails closed: open it again
  and retry once.

## Verification
1. `muxr surface capabilities` lists the provider-neutral capabilities.
2. `muxr surface list` shows the opened surface by logical name after `open`.
3. `muxr browser close` removes it; listing again shows it gone.
