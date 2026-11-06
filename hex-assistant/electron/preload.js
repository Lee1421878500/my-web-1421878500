'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 安全桥接：渲染进程只能通过这里暴露的有限接口与主进程通信
 * （contextIsolation 开启，不暴露 Node API）
 */
contextBridge.exposeInMainWorld('hexAPI', {
  isElectron: true,

  getState: () => ipcRenderer.invoke('hex:get-state'),

  toggleAutoAccept: force => ipcRenderer.invoke('hex:toggle-auto-accept', force),
  toggleClickThrough: force => ipcRenderer.invoke('hex:toggle-click-through', force),
  setOpacity: value => ipcRenderer.invoke('hex:set-opacity', value),
  setAcceptDelay: (min, max) => ipcRenderer.invoke('hex:set-accept-delay', min, max),
  reconnect: () => ipcRenderer.invoke('hex:reconnect'),

  minimize: () => ipcRenderer.send('hex:minimize'),
  quit: () => ipcRenderer.send('hex:quit'),

  /** 订阅主进程状态推送，返回取消订阅函数 */
  onState: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hex:state', handler);
    return () => ipcRenderer.removeListener('hex:state', handler);
  }
});
