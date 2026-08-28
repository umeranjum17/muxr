# Diagnostics

Owns flow-level checks, the doctor CLI entry, and the redacted diagnostics dump.

## Tree

```
scripts/diagnostics/
  index.mjs                 public entry (dump + waitForRelay)
  presentation/             doctor CLI wrapper
  application/              runSuite, check*, dumps, smokes, architecture guard
```

`checkArchitecture.mjs` rejects domain I/O, cross-context internal imports, infrastructure importing application/presentation (including dynamic import), and nested ternaries in first-party tooling files.
