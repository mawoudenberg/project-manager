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
  exportPdf:    (html, filename, defaultDir) => ipcRenderer.invoke('pdf:export',    { html, filename, defaultDir }),
  generatePdf:  (html)                       => ipcRenderer.invoke('pdf:generate',  { html }),
  openPdfBytes: (base64, filename)           => ipcRenderer.invoke('pdf:open-bytes', { base64, filename }),
  savePdfLocal: (base64, projectsDir, projectName, filename) => ipcRenderer.invoke('pdf:save-local', { base64, projectsDir, projectName, filename }),
  getLogoDataUrl: () => ipcRenderer.invoke('logo:get'),

  // Auto-update
  onUpdateAvailable:  (cb)  => ipcRenderer.on('app:update-available', (_e, d) => cb(d)),
  onDownloadComplete: (cb)  => ipcRenderer.on('app:download-complete', (_e, p) => cb(p)),
  openUrl:            (url) => ipcRenderer.invoke('app:open-url', url),
  openPath:           (p)   => ipcRenderer.invoke('shell:openPath', p),
  downloadUrl:        (url) => ipcRenderer.invoke('app:download-url', url),

  // DB sync (Google Drive changed the file)
  onDbChanged: (cb) => ipcRenderer.on('db:changed', () => cb()),

  // Quit app (for update flow)
  quitApp: () => ipcRenderer.invoke('app:quit'),
});
