'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

  // Cmd+Shift+I / F12 → DevTools for debugging
  const { globalShortcut } = require('electron');
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });

  // Auto-open DB if config exists
  const config = loadConfig();
  if (config && config.mode === 'file' && config.filePath) {
    try { openDb(config.filePath); } catch (e) {
      console.error('Failed to open DB on startup:', e.message);
    }
  }

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

ipcMain.handle('app:quit', () => { app.quit(); });

ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:set', (_e, config) => {
  const existing = loadConfig() || {};
  saveConfig({ ...existing, ...config });
  if (config.mode === 'file' && config.filePath) {
    openDb(config.filePath);
  }
  return { ok: true };
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Selecteer gedeelde map (bijv. Google Drive)',
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

ipcMain.handle('shell:openPath', (_e, p) => {
  shell.openPath(p);
});

ipcMain.handle('pdf:open-bytes', (_e, { base64, filename }) => {
  const tmpPath = path.join(os.tmpdir(), filename || 'offerte.pdf');
  fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
  shell.openPath(tmpPath);
});

ipcMain.handle('app:download-url', (_e, url) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.session.once('will-download', (_ev, item) => {
      const downloadsPath = app.getPath('downloads');
      const filePath = path.join(downloadsPath, item.getFilename());
      item.setSavePath(filePath);
      item.once('done', (_e2, state) => {
        if (state === 'completed' && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:download-complete', filePath);
        }
      });
    });
    mainWindow.webContents.downloadURL(url);
  }
});

app.whenReady().then(() => {
  // Check for updates 5 seconds after startup, then every hour
  setTimeout(checkForUpdates, 5000);
  setInterval(checkForUpdates, 60 * 60 * 1000);
});

// ─── Logo + PDF Export ────────────────────────────────────────────────────────

ipcMain.handle('logo:get', () => {
  const logoPath = path.join(__dirname, 'assets', 'logo.png');
  try {
    const data = fs.readFileSync(logoPath);
    return 'data:image/png;base64,' + data.toString('base64');
  } catch (_) { return null; }
});

ipcMain.handle('pdf:export', async (_e, { html, filename, defaultDir }) => {
  const tmpFile = path.join(os.tmpdir(), `quote-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmpFile, html, 'utf8');

    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await win.loadFile(tmpFile);
    // Small delay to ensure any webfonts / images are rendered
    await new Promise(r => setTimeout(r, 100));

    const pdfData = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
    });
    win.close();

    // Build default save path: use suggested folder if provided and it exists
    let suggestedPath = filename || 'offerte.pdf';
    if (defaultDir) {
      try {
        if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
        suggestedPath = path.join(defaultDir, filename || 'offerte.pdf');
      } catch (_) { /* fallback to filename only */ }
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedPath,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!result.canceled) {
      fs.writeFileSync(result.filePath, pdfData);
      shell.openPath(result.filePath);
      return { ok: true, pdfBase64: pdfData.toString('base64') };
    }
    return { ok: false };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

// Generate PDF bytes without showing a save dialog (used in API mode)
ipcMain.handle('pdf:generate', async (_e, { html }) => {
  const tmpFile = path.join(os.tmpdir(), `quote-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmpFile, html, 'utf8');
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await win.loadFile(tmpFile);
    await new Promise(r => setTimeout(r, 100));
    const pdfData = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
    });
    win.close();
    return pdfData.toString('base64');
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

// API mode: proxy HTTP requests from renderer to avoid CORS issues
ipcMain.handle('api:fetch', async (_e, { method, url, body, headers: extraHeaders }) => {
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
        ...(extraHeaders || {}),
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
