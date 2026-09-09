# Account

Proof of the person's muxr account.

## Language

**Account Credential**:
Proof of the person's muxr account. Independent of any Hosted Grant or relay ticket.
_Avoid_: token, pairing, device grant

## Ownership

- Domain interprets presence and HTTP status: empty proof is unavailability; 401 is rejection.
- Application fetches `/v1/session` and maps once through that domain decision. Named use cases: [USE_CASES.md](../USE_CASES.md).
- Presentation owns React auth.

## Invariants

- Account authentication never consults a machine display name or Hosted Grant.
- 401 is rejection, not unavailability. Network and non-401 failures are unavailability.
