# Using plugins

Connect muxr to a computer, then open **Settings → Plugins**. The catalog groups the current Browser, Code, terminal, voice, and machine plugins by job. Open **Other installed extensions** for community plugins and older registrations. Every installed plugin stays visible, including disabled or incompatible entries. Each row explains its job and shows its current state; its detail shows source, version, approval, and any declarative configuration contributed by the plugin.

Herdr runs plugins on the computer. **Off in Herdr** means the registration is disabled there; run `herdr plugin enable <plugin-id>` on that computer to turn it on. **Allow on this device** separately grants a paired device access to a plugin’s muxr UI and host calls. Revoking approval does not remove the Herdr registration, change its settings, or delete secrets. **Approve** means this device has not granted that access. **Update muxr** means the plugin needs a newer UI contract. **Offline** keeps cached catalog information visible while live settings are unavailable. A view-only browser can inspect plugin details but cannot approve or change configuration; use a control device for those actions.

## Names and titles

The agent name and task title shown in muxr are the values Herdr supplies. A manual rename stays visible after reconnection. muxr does not install a naming extension during connection or first-run setup.

If you want automatic naming, [Herdr Renamer](https://github.com/wyattjoh/herdr-plugin-renamer) is an optional community plugin. Its scope includes task and pane names and, in generated worktrees, local branch and workspace names. Inspect its configuration and the other naming extensions already installed before enabling it; `auto-namer` can name agents, panes, tabs, and workspaces, while `animal-namer` gives agents animal identities. Their existing registrations and settings remain separate. Install or enable a naming extension through Herdr on the computer, then inspect it in **Other installed extensions**. muxr will show the resulting Herdr names and titles without adding a second writer.

## Configuration and removal

**Realtime voice** uses native streaming speech-to-speech, separate from on-device **Dictation**. Open its detail to choose a provider and configure machine-held credentials. Other plugins show their own settings in their detail when they contribute `settings.items`. Extensions without a muxr UI are managed in Herdr.

**Browser** (`muxr.browser`) and **Code** (`muxr.code`) are the current surfaces. Older Terminal Browser and Terminal Code registrations, if still installed, appear under **Other installed extensions**; their existing panes remain separate. To inspect or change registrations, use Herdr’s `plugin list --json`, `plugin enable <id>`, and `plugin disable <id>` commands. Removing one is a separate Herdr action: check its exact ID and any active panes first.

To build or audit an extension, see the [developer plugin contract](PLUGINS.md). The [bundled plugin inventory](../plugins/README.md) lists the shipped roots and their responsibilities.
