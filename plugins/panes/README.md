# Panes and Tools

Panes lists ordinary shells and terminal applications. Tools lists enabled Herdr
plugins' explicitly global launch actions, using their declared names. Shells
and plugin setup panes are not duplicate application launchers.

A Tools tap resolves the current session on the host, creates a dedicated tab in
that workspace, and runs the enabled plugin's declared command against the
owned anchor pane. The launcher supplies the caller's project directory and
Herdr context, and includes the standard user executable directory in PATH.
Relative file arguments in the command are resolved against the installed
plugin root; auxiliary files should use HERDR_PLUGIN_ROOT.

The subprocess is bounded and its actual exit is checked. The action must
create exactly one pane within its owned tab. The empty anchor is then closed,
and the write RPC returns a declarative `navigation` destination. The generic
mobile action dispatcher accepts only session navigation from this completion;
it cannot recursively execute another RPC, capability or external URL.

A failed launch reports an error. An unused anchor is cleaned up. If the action
partially created a pane, it remains available through Panes for diagnosis;
unrelated panes are never closed. The launcher does not run a detached action
and report success before checking its outcome.

No Browser/Code provider IDs or executable names are encoded in mobile or in the
launcher. Discovery and execution use the current enabled plugin's declaration.
The installed plugin code runs with the same user permissions as other Herdr
actions; enabling and approving Tools remains a host-process capability.

## Verification

The existing bundled-plugin flow exercises catalog discovery, a real declared
command process, caller context/PATH, owned-pane creation, returned navigation,
failure cleanup, and preservation of unrelated panes. Real Browser and Code
launches are checked separately; a pane or browser inventory entry alone does
not prove phone graphics paint or scrolling performance.

Disable per device in Settings → Plugins, or with `herdr plugin disable muxr.panes`.
