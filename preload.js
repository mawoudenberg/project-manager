'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Database CRUD
  dbQuery: (payload) => ipcRenderer.invoke('db:query', payload),

  // Config
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (config) => ipcRenderer.invoke('config:set', config),

  // Native folder picker
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  // Manual refresh from disk (re-opens DB)
  refresh: () => ipcRenderer.invoke('app:refresh'),

  // API mode HTTP proxy (passes fetch through main to avoid CORS)
  apiFetch: (opts) => ipcRenderer.invoke('api:fetch', opts),

  // PDF export + logo
  exportPdf: (html, filename) => ipcRenderer.invoke('pdf:export', { html, filename }),
  getLogoDataUrl: () => ipcRenderer.invoke('logo:get'),

  // Auto-update
  onUpdateAvailable: (cb)   => ipcRenderer.on('app:update-available', (_e, d) => cb(d)),
  openUrl:           (url)  => ipcRenderer.invoke('app:open-url', url),

  // DB sync (Google Drive changed the file)
  onDbChanged: (cb) => ipcRenderer.on('db:changed', () => cb()),
});
