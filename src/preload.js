'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('mate', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  readVrm: () => ipcRenderer.invoke('read-vrm'),
  loadMotion: (id) => ipcRenderer.invoke('load-motion', id),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  showMenu: () => ipcRenderer.send('show-menu'),
  dropVrm: (file) => ipcRenderer.send('vrm-dropped', webUtils.getPathForFile(file)),
  onSettingsChanged: on('settings-changed'),
  onBoundsChanged: on('bounds-changed'),
  onCursor: on('cursor'),
  onCalibrateGaze: on('calibrate-gaze'),
  onPerformAction: on('perform-action'),
  onRemotePointer: on('remote-pointer'),
  sendCharRect: (r) => ipcRenderer.send('char-rect', r),
  getWeather: () => ipcRenderer.invoke('get-weather'),
  onWeather: on('weather'),
});
