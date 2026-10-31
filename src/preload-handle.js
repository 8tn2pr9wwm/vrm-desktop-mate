'use strict';

const { ipcRenderer } = require('electron');

globalThis.handleBridge = {
  sendPointer: (type, e) =>
    ipcRenderer.send('handle-pointer', {
      type,
      x: e.clientX,
      y: e.clientY,
      button: e.button,
    }),
};
