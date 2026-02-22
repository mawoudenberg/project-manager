'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// ─── Database ─────────────────────────────────────────────────────────────────

let dbModule = null;

function openDb(filePath) {
  if (!dbModule) dbModule = require('./db');
  dbModule.openDatabase(filePath);
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Project Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Auto-open DB if config exists
  const config = loadConfig();
  if (config && config.mode === 'file' && config.filePath) {
    try { openDb(config.filePath); } catch (e) {
      console.error('Failed to open DB on startup:', e.message);
    }
  }

  // Start CalDAV background sync if configured
  startCalDAVSync();
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:set', (_e, config) => {
  saveConfig(config);
  if (config.mode === 'file' && config.filePath) {
    openDb(config.filePath);
  }
  startCalDAVSync();
  return { ok: true };
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select shared folder (e.g. Google Drive)',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('app:refresh', () => {
  const config = loadConfig();
  if (config && config.mode === 'file' && config.filePath) {
    openDb(config.filePath);
  }
  return { ok: true };
});

ipcMain.handle('db:query', (_e, payload) => {
  if (!dbModule) throw new Error('Database not initialised');
  return dbModule.query(payload);
});

// ─── CalDAV credential helpers ────────────────────────────────────────────────

function encryptPassword(plain) {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64');
  }
  // Fallback: base64 only (not encrypted — warn user)
  return Buffer.from(plain).toString('base64');
}

function decryptPassword(stored) {
  if (!stored) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    }
    return Buffer.from(stored, 'base64').toString();
  } catch (_) { return ''; }
}

// ─── CalDAV background sync ───────────────────────────────────────────────────

let calDavTimer = null;
let calDavModule = null;
let lastSyncTime = null;
let lastSyncError = null;

function getCalDav() {
  if (!calDavModule) calDavModule = require('./caldav');
  return calDavModule;
}

function startCalDAVSync() {
  if (calDavTimer) { clearInterval(calDavTimer); calDavTimer = null; }
  const config = loadConfig();
  if (!config?.caldav?.enabled) return;

  // Run immediately after a short delay, then every 10 minutes
  setTimeout(() => runCalDAVSync(), 4000);
  calDavTimer = setInterval(() => runCalDAVSync(), 10 * 60 * 1000);
}

async function runCalDAVSync() {
  const config = loadConfig();
  if (!config?.caldav?.enabled || !dbModule) return;

  const { serverHost, username, passwordEncrypted, calendarUrl } = config.caldav;
  const password = decryptPassword(passwordEncrypted);
  if (!username || !password) return;

  const caldav = getCalDav();
  let resolvedUrl = calendarUrl;

  try {
    // Discover URL if not cached
    if (!resolvedUrl) {
      resolvedUrl = await caldav.discoverCalendarUrl({ serverHost, username, password });
      // Cache it
      const cfg = loadConfig();
      cfg.caldav.calendarUrl = resolvedUrl;
      saveConfig(cfg);
    }

    const remoteEntries = await caldav.fetchEvents({ calendarUrl: resolvedUrl, username, password });

    let imported = 0;
    for (const entry of remoteEntries) {
      const icsEvents = caldav.parseICS(entry.ics);
      for (const ev of icsEvents) {
        const changed = await syncRemoteEvent(ev, entry.etag);
        if (changed) imported++;
      }
    }

    lastSyncTime  = new Date();
    lastSyncError = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('caldav:synced', { time: lastSyncTime.toISOString(), imported });
    }
  } catch (err) {
    lastSyncError = err.message;
    console.error('CalDAV sync error:', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('caldav:error', err.message);
    }
  }
}

async function syncRemoteEvent(icsEv, etag) {
  const uid = icsEv.UID;
  if (!uid) return false;

  const title = icsEv.SUMMARY || '(geen titel)';
  const desc  = icsEv.DESCRIPTION || '';
  // DTSTART may be stored under "DTSTART" (DATE-TIME) or with params
  const dtRaw = icsEv.DTSTART || icsEv['DTSTART;VALUE=DATE'] || '';
  const date  = getCalDav().parseDTSTART(dtRaw);
  const status = icsEv.STATUS === 'CANCELLED' ? 'done' : 'pending';

  const existing = dbModule.query({ action: 'select', table: 'tasks', where: { caldav_uid: uid } });

  if (existing.length === 0) {
    dbModule.query({
      action: 'insert', table: 'tasks',
      data: {
        title, description: desc, date, status,
        caldav_uid: uid, caldav_etag: etag,
        created_by: 'CalDAV', priority: 'medium', color: '#7c5cbf',
      },
    });
    return true;
  }

  const task = existing[0];
  if (task.caldav_etag !== etag) {
    dbModule.query({
      action: 'update', table: 'tasks',
      data: { title, description: desc, date, status, caldav_etag: etag },
      where: { id: task.id },
    });
    return true;
  }
  return false;
}

// ─── CalDAV IPC handlers ──────────────────────────────────────────────────────

ipcMain.handle('caldav:save-config', async (_e, { serverHost, username, password, enabled, pushByDefault }) => {
  const cfg = loadConfig() || {};
  const passwordEncrypted = password ? encryptPassword(password) : cfg.caldav?.passwordEncrypted || '';
  cfg.caldav = {
    enabled:          !!enabled,
    serverHost:       serverHost || 'dav.strato.de',
    username:         username || '',
    passwordEncrypted,
    pushByDefault:    !!pushByDefault,
    calendarUrl:      null, // reset so it's re-discovered
  };
  saveConfig(cfg);
  startCalDAVSync();
  return { ok: true };
});

ipcMain.handle('caldav:get-config', () => {
  const cfg = loadConfig();
  const c = cfg?.caldav || {};
  return {
    enabled:       c.enabled      || false,
    serverHost:    c.serverHost   || 'dav.strato.de',
    username:      c.username     || '',
    pushByDefault: c.pushByDefault || false,
    hasPassword:   !!c.passwordEncrypted,
  };
});

ipcMain.handle('caldav:test', async (_e, { serverHost, username, password }) => {
  try {
    const caldav = getCalDav();
    const url = await caldav.discoverCalendarUrl({ serverHost, username, password });
    return { ok: true, calendarUrl: url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('caldav:sync-now', async () => {
  await runCalDAVSync();
  return { ok: true, lastSyncTime: lastSyncTime?.toISOString(), error: lastSyncError };
});

ipcMain.handle('caldav:push-task', async (_e, task) => {
  const cfg = loadConfig();
  const c = cfg?.caldav;
  if (!c?.enabled) return { ok: false, error: 'CalDAV niet geconfigureerd' };

  const caldav = getCalDav();
  const password = decryptPassword(c.passwordEncrypted);
  if (!password) return { ok: false, error: 'Geen wachtwoord opgeslagen' };

  // Discover calendar URL on-demand if not yet cached
  let calendarUrl = c.calendarUrl;
  if (!calendarUrl) {
    try {
      calendarUrl = await caldav.discoverCalendarUrl({ serverHost: c.serverHost, username: c.username, password });
      const freshCfg = loadConfig();
      freshCfg.caldav.calendarUrl = calendarUrl;
      saveConfig(freshCfg);
    } catch (err) {
      return { ok: false, error: `Kalender niet gevonden: ${err.message}` };
    }
  }
  const uid = task.caldav_uid || `pm-task-${task.id}@vonkenvorm.com`;
  const ics = caldav.generateICS({
    uid,
    title:       task.title,
    description: task.description,
    date:        task.date,
    status:      task.status,
  });

  try {
    const result = await caldav.putEvent({
      calendarUrl,
      username: c.username,
      password,
      uid,
      icsContent: ics,
    });
    // Update task with UID + etag
    if (dbModule && task.id) {
      dbModule.query({
        action: 'update', table: 'tasks',
        data: { caldav_uid: uid, caldav_etag: result.etag || '' },
        where: { id: task.id },
      });
    }
    return { ok: true, uid, etag: result.etag };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('caldav:status', () => ({
  lastSyncTime:  lastSyncTime?.toISOString() || null,
  lastSyncError,
}));

// ─── Logo + PDF Export ────────────────────────────────────────────────────────

ipcMain.handle('logo:get', () => {
  const logoPath = path.join(__dirname, 'assets', 'logo.png');
  try {
    const data = fs.readFileSync(logoPath);
    return 'data:image/png;base64,' + data.toString('base64');
  } catch (_) { return null; }
});

ipcMain.handle('pdf:export', async (_e, { html, filename }) => {
  const tmpFile = path.join(os.tmpdir(), `quote-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmpFile, html, 'utf8');

    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await win.loadFile(tmpFile);
    // Small delay to ensure any webfonts / images are rendered
    await new Promise(r => setTimeout(r, 300));

    const pdfData = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
    });
    win.close();

    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 'offerte.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!result.canceled) {
      fs.writeFileSync(result.filePath, pdfData);
      shell.openPath(result.filePath);
      return { ok: true };
    }
    return { ok: false };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

// API mode: proxy HTTP requests from renderer to avoid CORS issues
ipcMain.handle('api:fetch', async (_e, { method, url, body }) => {
  const https = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
});
