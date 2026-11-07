const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  activity: active => ipcRenderer.invoke('media-active', active),
  runtime: () => ipcRenderer.invoke('runtime'),
  preferences: (action, data) => ipcRenderer.invoke('preferences', action, data),
  audioStart: () => ipcRenderer.invoke('audio-start'),
  audioRepair: id => ipcRenderer.invoke('audio-repair', id),
  onInvite: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('room-invite', listener); return () => ipcRenderer.removeListener('room-invite', listener); },
  audioStop: id => ipcRenderer.invoke('audio-stop', id),
  onAudio: callback => { const listener = (_event, packet) => callback(packet); ipcRenderer.on('audio-packet', listener); return () => ipcRenderer.removeListener('audio-packet', listener); },
  sources: () => ipcRenderer.invoke('sources'),
  select: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  copy: value => ipcRenderer.invoke('copy', value)
});
