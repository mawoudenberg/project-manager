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

  // CalDAV calendar sync
  caldavSaveConfig:  (cfg)  => ipcRenderer.invoke('caldav:save-config', cfg),
  caldavGetConfig:   ()     => ipcRenderer.invoke('caldav:get-config'),
  caldavTest:        (cfg)  => ipcRenderer.invoke('caldav:test', cfg),
  caldavSyncNow:     ()     => ipcRenderer.invoke('caldav:sync-now'),
  caldavPushTask:    (task) => ipcRenderer.invoke('caldav:push-task', task),
  caldavDeleteTask:  (uid)  => ipcRenderer.invoke('caldav:delete-task', { uid }),
  caldavStatus:      ()     => ipcRenderer.invoke('caldav:status'),
  onCalDavSynced:    (cb)   => ipcRenderer.on('caldav:synced', (_e, d) => cb(d)),
  onCalDavError:     (cb)   => ipcRenderer.on('caldav:error',  (_e, m) => cb(m)),
});
