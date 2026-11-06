// The only bridge between the Studio page and the Mac: pick a folder, show it in Finder, open a link
// in your browser. No Node APIs reach the page.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signalDesktop', {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke('signal:pick-folder'),
  reveal: (p) => ipcRenderer.invoke('signal:reveal', String(p)),
  openExternal: (url) => ipcRenderer.invoke('signal:open-external', String(url)),
});
