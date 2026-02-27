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
let dbFilePath = null;
let dbMtime = null;
let dbPollTimer = null;

function openDb(filePath) {
  if (!dbModule) dbModule = require('./db');
  dbModule.openDatabase(filePath);
  dbFilePath = filePath;
  try { dbMtime = fs.statSync(filePath).mtimeMs; } catch (_) {}
  startDbPolling();
}

function startDbPolling() {
  if (dbPollTimer) { clearInterval(dbPollTimer); dbPollTimer = null; }
  if (!dbFilePath) return;
  dbPollTimer = setInterval(() => {
    try {
      const mtime = fs.statSync(dbFilePath).mtimeMs;
      if (mtime !== dbMtime) {
        dbMtime = mtime;
        dbModule.openDatabase(dbFilePath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('db:changed');
        }
      }
    } catch (_) {}
  }, 5000);
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
  const existing = loadConfig() || {};
  saveConfig({ ...existing, ...config });
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
  const result = dbModule.query(payload);
  // After a write, refresh our mtime so the poll doesn't treat it as a remote change
  if (payload.action !== 'select' && dbFilePath) {
    try { dbMtime = fs.statSync(dbFilePath).mtimeMs; } catch (_) {}
  }
  return result;
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
  } catch (_) {
    // safeStorage decrypt failed — fall back to plain base64 (setup-script credentials)
  }
  try { return Buffer.from(stored, 'base64').toString('utf8'); } catch (_) { return ''; }
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

  const { serverHost, username, passwordEncrypted, calendarUrl, calendarUrlOverride } = config.caldav;
  const password = decryptPassword(passwordEncrypted);
  if (!username || !password) return;

  const caldav = getCalDav();
  let resolvedUrl = calendarUrlOverride || calendarUrl;

  try {
    // Discover URL if not cached (skipped when calendarUrlOverride is set)
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

ipcMain.handle('caldav:save-config', async (_e, { serverHost, username, password, enabled, pushByDefault, calendarUrlOverride }) => {
  const cfg = loadConfig() || {};
  const passwordEncrypted = password ? encryptPassword(password) : cfg.caldav?.passwordEncrypted || '';
  cfg.caldav = {
    enabled:             !!enabled,
    serverHost:          serverHost || 'caldav.icloud.com',
    username:            username || '',
    passwordEncrypted,
    pushByDefault:       !!pushByDefault,
    calendarUrlOverride: calendarUrlOverride || '',
    calendarUrl:         null, // reset cached auto-discovered URL so it's re-discovered
  };
  saveConfig(cfg);
  startCalDAVSync();
  return { ok: true };
});

ipcMain.handle('caldav:get-config', () => {
  const cfg = loadConfig();
  const c = cfg?.caldav || {};
  return {
    enabled:             c.enabled             || false,
    serverHost:          c.serverHost           || 'caldav.icloud.com',
    username:            c.username             || '',
    pushByDefault:       c.pushByDefault        || false,
    calendarUrlOverride: c.calendarUrlOverride   || '',
    hasPassword:         !!c.passwordEncrypted,
  };
});

ipcMain.handle('caldav:test', async (_e, { serverHost, username, password }) => {
  try {
    const caldav = getCalDav();
    // If no password provided, use the stored one (user re-testing without re-typing password)
    let effectivePassword = password;
    if (!effectivePassword) {
      const cfg = loadConfig();
      if (cfg?.caldav?.passwordEncrypted) effectivePassword = decryptPassword(cfg.caldav.passwordEncrypted);
    }
    if (!effectivePassword) return { ok: false, error: 'Vul een wachtwoord in' };
    const url = await caldav.discoverCalendarUrl({ serverHost, username, password: effectivePassword });
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
  // Allow push as long as credentials are stored, even if auto-sync is disabled
  if (!c?.username || !c?.passwordEncrypted) return { ok: false, error: 'CalDAV niet geconfigureerd' };

  const caldav = getCalDav();
  const password = decryptPassword(c.passwordEncrypted);
  if (!password) return { ok: false, error: 'Geen wachtwoord opgeslagen' };

  // Use override URL if set, otherwise discover/cache
  let calendarUrl = c.calendarUrlOverride || c.calendarUrl;
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
  const uid = task.caldav_uid || `pm-task-${task.id}`;
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

ipcMain.handle('caldav:delete-task', async (_e, { uid }) => {
  const cfg = loadConfig();
  const c = cfg?.caldav;
  if (!c?.username || !c?.passwordEncrypted) return { ok: false, error: 'CalDAV niet geconfigureerd' };

  const caldav = getCalDav();
  const password = decryptPassword(c.passwordEncrypted);
  if (!password) return { ok: false, error: 'Geen wachtwoord opgeslagen' };

  let calendarUrl = c.calendarUrlOverride || c.calendarUrl;
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

  try {
    const { status } = await caldav.deleteEvent({ calendarUrl, username: c.username, password, uid });
    if (status === 200 || status === 204 || status === 404) return { ok: true };
    return { ok: false, error: `HTTP ${status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('caldav:status', () => ({
  lastSyncTime:  lastSyncTime?.toISOString() || null,
  lastSyncError,
}));

// ─── Auto-update check ────────────────────────────────────────────────────────

const REPO = 'mawoudenberg/project-manager';

async function checkForUpdates() {
  try {
    const https = require('https');
    const current = app.getVersion();
    const data = await new Promise((resolve, reject) => {
      const req = https.get(
        `https://api.github.com/repos/${REPO}/releases/latest`,
        { headers: { 'User-Agent': 'project-manager-app' } },
        (res) => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    if (!data || !data.tag_name) return;
    const latest = data.tag_name.replace(/^v/, '');

    function semverGt(a, b) {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
      }
      return false;
    }

    if (semverGt(latest, current)) {
      const assets = data.assets || [];
      const platform = process.platform; // 'darwin' | 'win32' | 'linux'
      let asset;
      if (platform === 'win32') {
        asset = assets.find(a => a.name.endsWith('.exe'));
      } else {
        // Pick arm64 DMG on Apple Silicon, universal otherwise
        const isArm = process.arch === 'arm64';
        asset = isArm
          ? assets.find(a => a.name.endsWith('-arm64.dmg'))
          : assets.find(a => a.name.endsWith('.dmg') && !a.name.includes('arm64'));
      }
      const url = asset ? asset.browser_download_url : data.html_url;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:update-available', { latest, url });
      }
    }
  } catch (_) {
    // silently ignore network errors during update check
  }
}

ipcMain.handle('app:open-url', (_e, url) => {
  shell.openExternal(url);
});

app.whenReady().then(() => {
  // Check for updates 5 seconds after startup
  setTimeout(checkForUpdates, 5000);
});

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
