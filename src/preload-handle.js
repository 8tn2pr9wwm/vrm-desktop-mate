'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('handleBridge', {
  sendPointer: (type, e) =>
    ipcRenderer.send('handle-pointer', {
      type,
      x: e.clientX,
      y: e.clientY,
      button: e.button,
    }),
});
