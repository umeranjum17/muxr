# Using plugins

Connect muxr to a computer first, then open **Settings → Plugins**. The catalog groups built-in plugins by job: agent workflow, files and changes, terminal and layout, voice and input, and usage and machine health. Extra Herdr extensions appear under **Installed extensions**, even when disabled. Open a row to see its source, version, effective state, permissions, and any configuration screen.

A plugin has two independent controls. **Herdr enablement** determines whether it runs on the computer. **Allow on this device** grants its muxr UI and host calls to one paired device. Turning device approval off does not uninstall or disable the Herdr plugin. A disabled Herdr plugin stays in the catalog; the detail tells you to run `herdr plugin enable <plugin-id>` on the computer. A view-only browser can inspect the catalog and read-only previews but cannot approve, configure, switch, or revert. Pair a control browser or use the native app for those actions.

## Task titles

The bundled **Task titles** plugin gives an agent task a short readable title from its first meaningful user prompt. Agent names still identify the agent. It updates at most once per task and leaves explicit start titles, Herdr renames, muxr manual renames, and existing labels alone. A wrapper-only prompt, uncertain text, missing transcript, or offline host keeps the current title. The **Preview** in its detail uses only the sample you type; it never writes Herdr metadata or stores the prompt.

If another task-title writer such as `herdr-plugin-renamer` or `auto-namer` is active, Task titles reports a conflict and does not write. **Switch to Task titles** turns off that writer only after your confirmation and records its former enabled state. **Restore previous title plugin** reverses the switch. Neither action uninstalls a plugin, removes its configuration, or changes titles already on panes. An identity plugin such as `animal-namer` can coexist. If you prefer an external title writer, leave Task titles off. You can inspect disabled plugins and their actual source in the same catalog.

## Voice and other settings

**Realtime voice** is live speech-to-speech, separate from on-device **Dictation**. Open Realtime voice’s detail to choose a provider and configure its machine-held credentials. Provider secrets stay with that plugin on the computer; a device approval switch never copies or deletes them. Other plugins expose **Open plugin settings** only when their manifest contributes a configuration screen. Extensions without muxr UI are managed with the Herdr CLI.

If a row says **Update app**, the plugin requires a newer muxr UI vocabulary; update the client before using it. **Not approved** means this device needs approval. **Off in Herdr** means the machine has it disabled. **Offline** leaves the last known catalog visible but prevents live changes. For installation, removal, and diagnostics, use `herdr plugin list --json`, `herdr plugin enable <id>`, `herdr plugin disable <id>`, and Herdr’s plugin documentation. Removing an extension is a separate Herdr action; first disable it and check whether it owns live titles or other data.

To build or audit an extension, see the [developer plugin contract](PLUGINS.md). The [bundled plugin inventory](../plugins/README.md) lists the shipped roots and their responsibilities.
