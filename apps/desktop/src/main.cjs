const { app, BrowserWindow, Menu, Tray, dialog, session } = require('electron');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DEV_URL = process.env.BEDROCK_PANEL_UI_URL || 'http://127.0.0.1:5176';
const API_HOST = process.env.BEDROCK_PANEL_API_HOST || '127.0.0.1';
const DEFAULT_API_PORT = Number(process.env.BEDROCK_PANEL_API_PORT || '3001');
const IS_DEV = process.env.NODE_ENV === 'development' || !!process.env.BEDROCK_PANEL_UI_URL;

let apiProcess = null;
let mainWindow = null;
let tray = null;
let apiPort = DEFAULT_API_PORT;

function getApiUrl() {
  return `http://${API_HOST}:${apiPort}`;
}

function getHealthUrl() {
  return `${getApiUrl()}/health`;
}

function getApiEntryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'apps', 'api', 'dist', 'index.js');
  }

  return path.resolve(__dirname, '../../api/dist/index.js');
}

function getManagedServerDir() {
  return path.join(app.getPath('userData'), 'bedrock-server');
}

function ensureRuntimeDirectories() {
  fs.mkdirSync(getManagedServerDir(), { recursive: true });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.listen(port, API_HOST, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

async function resolveApiPort() {
  if (IS_DEV) {
    return;
  }

  if (await isPortAvailable(DEFAULT_API_PORT)) {
    apiPort = DEFAULT_API_PORT;
    return;
  }

  for (let offset = 1; offset <= 20; offset += 1) {
    const candidate = DEFAULT_API_PORT + offset;
    if (await isPortAvailable(candidate)) {
      apiPort = candidate;
      return;
    }
  }

  throw new Error('Unable to find an available local API port. Please close other Bedrock Panel instances and try again.');
}

function waitForApi(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`API health check failed with status ${response.statusCode ?? 'unknown'}.`));
          return;
        }

        setTimeout(attempt, 350);
      });

      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('Timed out waiting for the local API to start.'));
          return;
        }

        setTimeout(attempt, 350);
      });
    };

    attempt();
  });
}

function startApiProcess() {
  if (IS_DEV || apiProcess) {
    return;
  }

  const apiEntryPath = getApiEntryPath();
  ensureRuntimeDirectories();

  apiProcess = spawn(process.execPath, [apiEntryPath], {
    cwd: app.getPath('userData'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      API_HOST,
      API_PORT: String(apiPort),
      WEB_ORIGIN: getApiUrl(),
      BEDROCK_SERVER_DIR: process.env.BEDROCK_SERVER_DIR || getManagedServerDir(),
    },
    stdio: 'inherit',
    windowsHide: true,
  });

  apiProcess.once('exit', (code, signal) => {
    apiProcess = null;
    if (!app.isQuitting) {
      const details = `The local Bedrock service exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
      void dialog.showErrorBox('Bedrock Panel service stopped', details);
      app.quit();
    }
  });
}

function stopApiProcess() {
  if (!apiProcess || apiProcess.killed) {
    return;
  }

  app.isQuitting = true;
  apiProcess.kill('SIGTERM');
}

function createTray() {
  if (tray || IS_DEV) {
    return;
  }

  const iconPath = path.resolve(__dirname, '../../../PIC/launcher.png');
  tray = new Tray(iconPath);
  tray.setToolTip('Bedrock Panel');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Bedrock Panel',
        click: () => {
          if (!mainWindow) {
            createWindow();
            return;
          }

          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );

  tray.on('double-click', () => {
    if (!mainWindow) {
      createWindow();
      return;
    }

    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#ece4cf',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.on('close', (event) => {
    if (!IS_DEV && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(IS_DEV ? DEV_URL : getApiUrl());
}

app.whenReady().then(async () => {
  if (!IS_DEV) {
    try {
      await resolveApiPort();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to resolve API port.';
      dialog.showErrorBox('Bedrock Panel failed to start', message);
      app.quit();
      return;
    }

    startApiProcess();

    try {
      await waitForApi(getHealthUrl());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown startup error';
      dialog.showErrorBox('Bedrock Panel failed to start', message);
      stopApiProcess();
      app.quit();
      return;
    }
  }

  createTray();
  createWindow();

  // ── Webview: strip framing-block headers from CurseForge ──────────────
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['https://www.curseforge.com/*', 'https://*.curseforge.com/*'] },
    (details, callback) => {
      const responseHeaders = Object.fromEntries(
        Object.entries(details.responseHeaders || {}).filter(
          ([k]) => k.toLowerCase() !== 'x-frame-options',
        ),
      );
      callback({ responseHeaders });
    },
  );

  // ── Downloads: intercept and save to server downloads/ folder ────────
  const downloadsDir = path.join(
    process.env.BEDROCK_SERVER_DIR || getManagedServerDir(),
    'downloads',
  );
  fs.mkdirSync(downloadsDir, { recursive: true });
  session.defaultSession.on('will-download', (_event, item) => {
    const filename = item.getFilename();
    const savePath = path.join(downloadsDir, filename);
    item.setSavePath(savePath);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (IS_DEV) {
      stopApiProcess();
      app.quit();
    }
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopApiProcess();
});
