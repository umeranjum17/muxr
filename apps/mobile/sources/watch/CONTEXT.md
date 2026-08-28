# Watch

Machine-scoped Lifecycle Events and the Voice Reports that follow from them.

## Language

**Lifecycle Event**:
A host-emitted change in an Agent's working, blocked, done, or failed state, keyed by Agent Route.
_Avoid_: status tick, attention row

## Ownership

- Domain owns Lifecycle Event predicates and Voice Report parse/admit rules. Parse fails closed. Spoken Human Name must not be an internal id.
- Application owns Agent Watch persistence, scope, and Voice Report admission. Named use cases: [USE_CASES.md](../USE_CASES.md).

## Invariants

- Agent Route + identity authorize. Display metadata never does.
- Invalid Voice Reports never persist.
- `lifecycleStateSince` is the last state change, not the last tick.
- Human alerts are blocked, failed, or done. Routine voice is idle or done.


**Agent Watch**:
The machine-scoped record of Lifecycle Events and the human-visible reports that follow from them.
_Avoid_: inbox, notification store, voice queue

**Voice Report**:
A spoken update about a trusted Human Name and Task Title, admitted only after current-schema validation.
_Avoid_: TTS job, announcement
