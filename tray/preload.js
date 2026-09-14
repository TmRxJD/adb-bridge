const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bridgeTray', {
  loadSettings: gameId => ipcRenderer.invoke('settings:load', gameId),
  saveSettings: (gameId, values) => ipcRenderer.invoke('settings:save', gameId, values),
  consoleBuffer: () => ipcRenderer.invoke('console:buffer'),
  onLog: callback => ipcRenderer.on('bridge-log', (_event, line) => callback(String(line))),
})
