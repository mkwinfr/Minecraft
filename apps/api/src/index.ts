import cors from 'cors';
import express from 'express';
import { resolve } from 'node:path';
import type {
  DownloadInstallResponse,
  DownloadsListResponse,
  HealthResponse,
  InstallerActionResponse,
  InstallerDiscoveryResponse,
  InstallerStatusResponse,
  LogEvent,
  ServerFileActionResponse,
  ServerFilesListResponse,
  ServerFileTextResponse,
  ServerActionResponse,
} from '@bedrock-panel/shared';
import { loadConfig } from './config';
import {
  configureBedrockInstaller,
  getBedrockInstallerStatus,
  installOrUpdateBedrockServer,
  previewResolvedDownloadUrl,
} from './services/bedrock-installer';
import {
  configureProcessManager,
  getRecentServerLogs,
  getServerStatus,
  requestServerAction,
  shutdownProcessManager,
  subscribeServerLogs,
} from './services/process-manager';
import {
  configureTelemetryService,
  getServerTelemetry,
  recordApiRequestTelemetry,
  recordInstallerTelemetry,
  recordServerActionTelemetry,
  startTelemetryService,
  stopTelemetryService,
} from './services/telemetry-service';
import {
  configurePropertiesService,
  readServerProperties,
  writeServerProperties,
} from './services/properties-service';
import {
  configurePacksService,
  listPacks,
  setPackActive,
  deletePack,
  installPackBuffer,
  inspectPackBuffer,
  getPackIconPath,
} from './services/packs-service';
import {
  configureFilesService,
  createServerDirectory,
  deleteDownloadFile,
  deleteServerPath,
  getDownloadIconBuffer,
  getWorldIconBuffer,
  getServerFileDownloadPath,
  getServerFolderZipBuffer,
  listDownloads,
  listServerFiles,
  readDownloadBuffer,
  readServerTextFile,
  renameServerPath,
  writeServerTextFile,
  writeUploadedFile,
} from './services/files-service';
import multer from 'multer';

let config: import('./config').AppConfig;
try {
  config = loadConfig();
} catch (error) {
  const msg = error instanceof Error ? error.message : 'Failed to load configuration';
  console.error(`❌ Configuration error: ${msg}`);
  process.exit(1);
}

const app = express();

configureProcessManager({
  bedrockServerDir: config.BEDROCK_SERVER_DIR,
  bedrockServerExe: config.BEDROCK_SERVER_EXE,
  bedrockStopCommand: config.BEDROCK_STOP_COMMAND,
  bedrockStopTimeoutMs: config.BEDROCK_STOP_TIMEOUT_MS,
});

configureBedrockInstaller({
  bedrockServerDir: config.BEDROCK_SERVER_DIR,
  bedrockServerExe: config.BEDROCK_SERVER_EXE,
  bedrockDownloadUrl: config.BEDROCK_DOWNLOAD_URL,
});

configureTelemetryService({
  bedrockServerDir: config.BEDROCK_SERVER_DIR,
});
startTelemetryService();

configurePropertiesService({
  bedrockServerDir: config.BEDROCK_SERVER_DIR,
});

configurePacksService({
  bedrockServerDir: config.BEDROCK_SERVER_DIR,
});

configureFilesService({
  bedrockServerDir: config.BEDROCK_SERVER_DIR,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

app.use(cors({ origin: config.WEB_ORIGIN }));
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    recordApiRequestTelemetry(req.path, Date.now() - startedAt, res.statusCode);
  });
  next();
});

app.get('/health', (_req, res) => {
  const payload: HealthResponse = {
    ok: true,
    service: 'api',
    timestamp: new Date().toISOString(),
  };

  res.json(payload);
});

app.get('/api/server/status', (_req, res) => {
  const runtimeStatus = getServerStatus();
  const installerStatus = getBedrockInstallerStatus();
  res.json({
    ...runtimeStatus,
    bedrockVersion: installerStatus.installedVersion,
  });
});

app.get('/api/server/installer/status', (_req, res) => {
  const payload: InstallerStatusResponse = getBedrockInstallerStatus();
  res.json(payload);
});

app.get('/api/server/installer/discover-url', async (_req, res) => {
  let url: string;
  try {
    url = await previewResolvedDownloadUrl();
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : 'Unknown discovery error';
    res.status(400).json({ error: 'Bedrock URL discovery failed', details });
    return;
  }

  const payload: InstallerDiscoveryResponse = { url };
  res.json(payload);
});

app.post('/api/server/installer/install', async (req, res) => {
  const downloadUrl =
    typeof req.body?.downloadUrl === 'string' ? req.body.downloadUrl.trim() : undefined;

  let payload: InstallerActionResponse;
  try {
    payload = await installOrUpdateBedrockServer(downloadUrl);
    recordInstallerTelemetry(true, payload.message);
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : 'Unknown installer error';
    recordInstallerTelemetry(false, `Install failed: ${details}`);
    res.status(400).json({ error: 'Bedrock install failed', details });
    return;
  }

  res.json(payload);
});

app.get('/api/server/properties', (_req, res) => {
  readServerProperties()
    .then((result) => res.json(result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to read server.properties';
      res.status(500).json({ error: msg });
    });
});

app.post('/api/server/properties', (req, res) => {
  const body = req.body as { properties?: unknown };
  if (!body || typeof body.properties !== 'object' || body.properties === null) {
    res.status(400).json({ error: 'Missing properties object in request body' });
    return;
  }
  writeServerProperties(body.properties as import('@bedrock-panel/shared').BedrockServerProperties)
    .then(() =>
      res.json({ ok: true, message: 'server.properties saved. Restart the server for changes to take effect.' }),
    )
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to write server.properties';
      res.status(500).json({ error: msg });
    });
});

app.get('/api/server/packs/icon/:type/:uuid', (req, res) => {
  const type = req.params.type as 'behavior' | 'resource';
  const { uuid } = req.params;
  if (!['behavior', 'resource'].includes(type)) {
    res.status(400).json({ error: 'Invalid pack type' });
    return;
  }
  getPackIconPath(type, uuid)
    .then(async (iconPath) => {
      if (!iconPath) {
        res.status(404).end();
        return;
      }
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(iconPath);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(data);
    })
    .catch(() => res.status(500).end());
});

app.get('/api/server/packs', (_req, res) => {
  listPacks()
    .then((result) => res.json(result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to list packs';
      res.status(500).json({ error: msg });
    });
});

app.patch('/api/server/packs/:type/:uuid', (req, res) => {
  const type = req.params.type as 'behavior' | 'resource';
  const { uuid } = req.params;
  const { active } = req.body as { active?: boolean };
  if (!['behavior', 'resource'].includes(type)) {
    res.status(400).json({ error: 'Invalid pack type' });
    return;
  }
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'Missing active boolean in request body' });
    return;
  }
  setPackActive(type, uuid, active)
    .then(() => res.json({ ok: true, active, message: active ? 'Pack activated' : 'Pack deactivated' }))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to toggle pack';
      res.status(500).json({ error: msg });
    });
});

app.delete('/api/server/packs/:type/:uuid', (req, res) => {
  const type = req.params.type as 'behavior' | 'resource';
  const { uuid } = req.params;
  if (!['behavior', 'resource'].includes(type)) {
    res.status(400).json({ error: 'Invalid pack type' });
    return;
  }
  deletePack(type, uuid)
    .then(() => res.json({ ok: true, message: 'Pack deleted' }))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to delete pack';
      res.status(500).json({ error: msg });
    });
});

app.post('/api/server/packs/upload', upload.array('pack'), (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const invalid = files.find((file) => {
    const lower = file.originalname.toLowerCase();
    return !lower.endsWith('.mcpack') && !lower.endsWith('.mcaddon');
  });

  if (invalid) {
    res.status(400).json({ error: 'Only .mcpack and .mcaddon files are accepted' });
    return;
  }

  Promise.all(files.map((file) => installPackBuffer(file.buffer, file.originalname)))
    .then((results) => {
      const installed = results.flat();
      res.json({
        ok: true,
        installed,
        message: `Installed ${installed.length} pack(s) from ${files.length} file(s)`,
      });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to install pack';
      res.status(500).json({ error: msg });
    });
});

app.get('/api/server/files', (req, res) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '.';
  listServerFiles(relativePath)
    .then((payload: ServerFilesListResponse) => res.json(payload))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to list files';
      res.status(400).json({ error: msg });
    });
});

app.post('/api/server/files/text/read', (req, res) => {
  const relativePath = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!relativePath) {
    res.status(400).json({ error: 'Missing path in request body' });
    return;
  }

  readServerTextFile(relativePath)
    .then((content) => {
      const payload: ServerFileTextResponse = { path: relativePath, content };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to read file';
      res.status(400).json({ error: msg });
    });
});

app.post('/api/server/files/text/write', (req, res) => {
  const relativePath = typeof req.body?.path === 'string' ? req.body.path : '';
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  if (!relativePath || content === null) {
    res.status(400).json({ error: 'Missing path or content in request body' });
    return;
  }

  writeServerTextFile(relativePath, content)
    .then(() => {
      const payload: ServerFileActionResponse = {
        ok: true,
        message: 'File saved',
      };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to save file';
      res.status(400).json({ error: msg });
    });
});

app.post('/api/server/files/directory', (req, res) => {
  const relativePath = typeof req.body?.path === 'string' ? req.body.path : '.';
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (!name.trim()) {
    res.status(400).json({ error: 'Missing folder name in request body' });
    return;
  }

  createServerDirectory(relativePath, name)
    .then(() => {
      const payload: ServerFileActionResponse = {
        ok: true,
        message: 'Folder created',
      };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to create folder';
      res.status(400).json({ error: msg });
    });
});

app.post('/api/server/files/rename', (req, res) => {
  const relativePath = typeof req.body?.path === 'string' ? req.body.path : '';
  const newName = typeof req.body?.newName === 'string' ? req.body.newName : '';
  if (!relativePath || !newName.trim()) {
    res.status(400).json({ error: 'Missing path or newName in request body' });
    return;
  }

  renameServerPath(relativePath, newName)
    .then(() => {
      const payload: ServerFileActionResponse = {
        ok: true,
        message: 'Item renamed',
      };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to rename item';
      res.status(400).json({ error: msg });
    });
});

app.post('/api/server/files/delete', (req, res) => {
  const relativePath = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!relativePath) {
    res.status(400).json({ error: 'Missing path in request body' });
    return;
  }

  deleteServerPath(relativePath)
    .then(() => {
      const payload: ServerFileActionResponse = {
        ok: true,
        message: 'Item deleted',
      };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to delete item';
      res.status(400).json({ error: msg });
    });
});

app.post('/api/server/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const relativePath = typeof req.body?.path === 'string' ? req.body.path : '.';
  writeUploadedFile(relativePath, req.file.originalname, req.file.buffer)
    .then(() => {
      const payload: ServerFileActionResponse = {
        ok: true,
        message: `Uploaded ${req.file?.originalname}`,
      };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to upload file';
      res.status(400).json({ error: msg });
    });
});

app.get('/api/server/files/download', (req, res) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!relativePath) {
    res.status(400).json({ error: 'Missing path query parameter' });
    return;
  }

  let absolutePath: string;
  try {
    absolutePath = getServerFileDownloadPath(relativePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid path';
    res.status(400).json({ error: msg });
    return;
  }

  res.download(absolutePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'Failed to download file' });
    }
  });
});

app.get('/api/server/files/download-zip', (req, res) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!relativePath) {
    res.status(400).json({ error: 'Missing path query parameter' });
    return;
  }

  getServerFolderZipBuffer(relativePath)
    .then(({ buffer, folderName }) => {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
      res.send(buffer);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to create zip';
      res.status(400).json({ error: msg });
    });
});

// ── Downloads routes ────────────────────────────────────────────────────────

app.get('/api/server/downloads', (_req, res) => {
  listDownloads()
    .then(async (entries) => {
      const enrichedEntries = await Promise.all(
        entries.map(async (entry) => {
          try {
            const { buffer, filename } = await readDownloadBuffer(entry.filename);
            const packs = await inspectPackBuffer(buffer, filename);
            return { ...entry, packs };
          } catch {
            return { ...entry, packs: [] };
          }
        }),
      );
      const payload: DownloadsListResponse = { entries: enrichedEntries };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to list downloads';
      res.status(500).json({ error: msg });
    });
});

app.get('/api/server/downloads/icon/:filename', (req, res) => {
  const { filename } = req.params;
  getDownloadIconBuffer(filename)
    .then((buf) => {
      if (!buf) { res.status(404).end(); return; }
      res.setHeader('Content-Type', 'image/png');
      res.send(buf);
    })
    .catch(() => res.status(404).end());
});

app.get('/api/server/worlds/icon', (req, res) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (!path.trim()) {
    res.status(400).json({ error: 'Missing world path query parameter.' });
    return;
  }

  getWorldIconBuffer(path)
    .then((icon) => {
      if (!icon) {
        res.status(404).end();
        return;
      }

      res.setHeader('Content-Type', icon.contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(icon.buffer);
    })
    .catch(() => res.status(404).end());
});

app.delete('/api/server/downloads/:filename', (req, res) => {
  const { filename } = req.params;
  deleteDownloadFile(filename)
    .then(() => res.json({ ok: true, message: `Deleted ${filename}` }))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to delete download';
      res.status(400).json({ error: msg });
    });
});

app.post('/api/server/downloads/install', (req, res) => {
  const filename = typeof req.body?.filename === 'string' ? req.body.filename : '';
  if (!filename) { res.status(400).json({ error: 'Missing filename' }); return; }

  readDownloadBuffer(filename)
    .then(({ buffer, filename: fname }) => installPackBuffer(buffer, fname))
    .then((installed) => {
      const payload: DownloadInstallResponse = {
        ok: true,
        installed,
        message: `Installed ${installed.length} pack(s) from ${filename}`,
      };
      res.json(payload);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to install from downloads';
      res.status(500).json({ error: msg });
    });
});

app.post('/api/server/:action', async (req, res) => {
  const action = req.params.action as 'start' | 'stop' | 'restart';
  if (!['start', 'stop', 'restart'].includes(action)) {
    res.status(400).json({ error: 'Invalid action' });
    return;
  }

  const startedAt = Date.now();
  let message: string;
  try {
    message = await requestServerAction(action);
    recordServerActionTelemetry(action, Date.now() - startedAt, true);
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : 'Unknown action error';
    recordServerActionTelemetry(action, Date.now() - startedAt, false);
    res.status(400).json({ error: 'Failed to execute server action', details });
    return;
  }

  const payload: ServerActionResponse = {
    action,
    accepted: true,
    message,
    requestedAt: new Date().toISOString(),
  };

  res.json(payload);
});

app.get('/api/server/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (line: string) => {
    const event: LogEvent = {
      kind: 'log',
      at: new Date().toISOString(),
      line,
    };

    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send('Log stream connected.');
  for (const line of getRecentServerLogs()) {
    send(line);
  }

  const unsubscribe = subscribeServerLogs((line) => {
    send(line);
  });

  const timer = setInterval(() => {
    send('Heartbeat: stream alive.');
  }, 4000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(timer);
    res.end();
  });
});

app.get('/api/server/telemetry', (_req, res) => {
  res.json(getServerTelemetry());
});

// Any unmatched API route should return JSON, never the SPA HTML fallback.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: `API route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Serve static files from the web build (production)
// Path is: from dist/index.js -> up 3 levels to bedrock-panel -> then to apps/api/public
const publicDir = resolve(__dirname, '..', '..', '..', 'apps', 'api', 'public');
console.log(`📁 Serving static files from: ${publicDir}`);

const sendSpaIndex = (res: express.Response) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile('index.html', { root: publicDir }, (err) => {
    if (err) {
      res.status(404).send('Not found');
    }
  });
};

app.use(
  express.static(publicDir, {
    index: false,
    maxAge: '365d',
    immutable: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
      }
    },
  }),
);

app.get('/', (_req, res) => {
  sendSpaIndex(res);
});

// Fallback to index.html for SPA routing (must come after all API routes)
app.use((req, res) => {
  sendSpaIndex(res);
});

process.on('SIGINT', () => {
  stopTelemetryService();
  void shutdownProcessManager().finally(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  stopTelemetryService();
  void shutdownProcessManager().finally(() => {
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error(`❌ Uncaught exception: ${msg}`);
  if (error instanceof Error) {
    console.error(error.stack);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`❌ Unhandled rejection: ${msg}`);
  if (reason instanceof Error) {
    console.error(reason.stack);
  }
  process.exit(1);
});

const server = app.listen(config.API_PORT, config.API_HOST, () => {
  console.log(
    `API listening on http://${config.API_HOST}:${config.API_PORT} (origin: ${config.WEB_ORIGIN})`,
  );
});

server.on('error', (error) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error(`❌ Server error: ${msg}`);
  if (error instanceof Error) {
    console.error(error.stack);
  }
  process.exit(1);
});
