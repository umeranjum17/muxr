# Catalog

The listed Agents on this device and the transcript envelopes that belong to them.

## Language

**Agent**:
One current Herdr `agent_session` generation projected into the herd. A bare Shell is a separate pane path, not an Agent.
_Avoid_: pane, tab, provider binary, prior generation

**Agent Route**:
The opaque authorization route bound to exactly one Herdr `agent_session` generation. It survives pane moves; a replacement process receives a new route.
_Avoid_: pane id, spoken name, label

**Agent Name**:
The current Herdr `agent.name`, rendered directly without a mobile alias or cached fallback.
_Avoid_: label, pane title, cached name

**Task Title**:
The current Herdr Agent title, pane label, or tab label in that order.
_Avoid_: cached title, terminal title

**Provider Kind**:
The current Herdr Agent provider.
_Avoid_: agent name, model

Use cases: [USE_CASES.md](../USE_CASES.md).
