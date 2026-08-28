# muxr herd identity

muxr shows coding agents running on a computer. Identity is what a person uses to tell one Agent from another; routing never uses those words.

## Language

**Agent**:
A coding-agent session muxr tracks. It is the person-shaped row in the herd, not a Herdr pane and not a provider binary.
_Avoid_: pane, tab, process, session row

**Human Name**:
The spoken first name of an Agent (John, Maria). Secondary, display-only, never a routing key.
_Avoid_: label, autoLabel, animal name, agent name, display label

**Task Title**:
The work the Agent is doing. Primary identity for humans scanning a herd.
_Avoid_: label, pane title, terminal title, name

**Provider Kind**:
Which coding-agent program is running (pi, claude, codex). Separate from Human Name and Task Title.
_Avoid_: agent name, kind label, model

**Agent Route**:
The stable muxr session id that names an Agent across pane moves. The only key used to prompt, watch, or focus.
_Avoid_: pane id, spoken name, label, Herdr agent name

**Lifecycle Event**:
A recorded change in an Agent's working/blocked/done/failed state, keyed by Agent Route.
_Avoid_: status string, attention row, watch receipt
