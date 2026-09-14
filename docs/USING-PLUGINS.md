# Using plugins

Connect muxr to a computer first, then open **Settings → Plugins**. The catalog groups built-in plugins by job: files and changes, terminal and layout, voice and input, and usage and machine health. Extra Herdr extensions appear under **Installed extensions**, even when disabled. Open a row to see its source, version, effective state, permissions, and any configuration screen.

A plugin has two independent controls. **Herdr enablement** determines whether it runs on the computer. **Allow on this device** grants its muxr UI and host calls to one paired device. Turning device approval off does not uninstall or disable the Herdr plugin. A disabled Herdr plugin stays in the catalog; the detail tells you to run `herdr plugin enable <plugin-id>` on the computer. A view-only browser can inspect the catalog but cannot approve or configure plugins. Pair a control browser or use the native app for those actions.

## Agent names and titles

muxr displays the agent names and task titles supplied by Herdr. It does not generate or change them. For automatic task titles, you can install an optional third-party Herdr extension such as [Herdr Renamer](https://github.com/wyattjoh/herdr-plugin-renamer) on your computer. Manage its registration and settings in Herdr; muxr shows the extension in **Installed extensions** when connected.

## Voice and other settings

**Realtime voice** is live speech-to-speech, separate from on-device **Dictation**. Open Realtime voice’s detail to choose a provider and configure its machine-held credentials. Provider secrets stay with that plugin on the computer; a device approval switch never copies or deletes them. Other plugins show configuration inside their detail when their manifest contributes a settings screen. Extensions without muxr UI are managed with the Herdr CLI.

If a row says **Update muxr**, the plugin requires a newer muxr UI vocabulary; update the client before using it. **Approve** means this device needs approval. **Off in Herdr** means the machine has it disabled. **Offline** keeps a previously loaded catalog visible but prevents live changes. For installation, removal, and diagnostics, use `herdr plugin list --json`, `herdr plugin enable <id>`, `herdr plugin disable <id>`, and Herdr’s plugin documentation. Removing an extension is a separate Herdr action; first disable it and check whether it owns live titles or other data.

To build or audit an extension, see the [developer plugin contract](PLUGINS.md). The [bundled plugin inventory](../plugins/README.md) lists the shipped roots and their responsibilities.
