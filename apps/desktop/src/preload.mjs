/**
 * The renderer bridge: the window is untrusted, so it only sees these calls.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('muxr', {
    onState: (callback) => ipcRenderer.on('muxr:state', (_event, value) => callback(value)),
    onSettings: (callback) => ipcRenderer.on('muxr:settings', (_event, value) => callback(value)),
    getSettings: () => ipcRenderer.invoke('muxr:settings'),
    approve: () => ipcRenderer.invoke('muxr:approve'),
    deny: () => ipcRenderer.invoke('muxr:deny'),
    retry: () => ipcRenderer.invoke('muxr:retry'),
    installHerdr: () => ipcRenderer.invoke('muxr:install-herdr'),
    setProjectFolder: (folder) => ipcRenderer.invoke('muxr:set-project-folder', folder),
    setKeepAwake: (on) => ipcRenderer.invoke('muxr:set-keep-awake', on),
    setAutostart: (on) => ipcRenderer.invoke('muxr:set-autostart', on),
    copyCode: (text) => ipcRenderer.invoke('muxr:copy', text),
    quit: () => ipcRenderer.invoke('muxr:quit'),
});
