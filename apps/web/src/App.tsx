import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ServerFileEntry,
  BedrockServerProperties,
  DownloadEntry,
  InstallerStatusResponse,
  LogEvent,
  ServerLifecycleState,
  ServerStatusResponse,
  ServerTelemetryResponse,
} from '@bedrock-panel/shared';
import type { BedrockPack } from './lib/api';
import {
  connectLogs,
  createServerFolder,
  deleteServerPath,
  deletePack,
  deleteDownload,
  fetchDownloads,
  fetchHealth,
  fetchInstallerStatus,
  fetchServerFiles,
  fetchPacks,
  fetchServerProperties,
  readServerTextFile,
  renameServerPath,
  serverFileDownloadUrl,
  fetchServerStatus,
  fetchServerTelemetry,
  installFromDownloads,
  packIconUrl,
  postInstallerInstall,
  postServerAction,
  serverFolderZipUrl,
  togglePack,
  updateServerProperties,
  uploadServerFile,
  uploadPacks,
  worldIconUrl,
  writeServerTextFile,
} from './lib/api';
import { TestPage } from './pages/test/TestPage';
import './App.css';

type LeftPage =
  | 'home'
  | 'bedrock-edition'
  | 'java-edition'
  | 'test'
  | 'server-settings'
  | 'server-files'
  | 'console-feed';
type ServerSettingsTab = 'server-status' | 'properties' | 'general';

const leftPages: Array<{ id: LeftPage; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'bedrock-edition', label: 'Minecraft: Bedrock Edition' },
  { id: 'server-settings', label: 'Server Settings' },
  { id: 'server-files', label: 'Server Files' },
];

const stateLabel: Record<ServerLifecycleState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  crashed: 'Crashed',
};

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatMetric(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) {
    return 'n/a';
  }

  return value.toFixed(digits);
}

function formatMs(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  return `${Math.round(value)} ms`;
}

const fallbackStatus: ServerStatusResponse = {
  state: 'stopped',
  pid: null,
  uptimeMs: 0,
  bedrockVersion: null,
};

const fallbackInstallerStatus: InstallerStatusResponse = {
  installed: false,
  installedVersion: null,
  executablePath: '',
  downloadUrlConfigured: false,
  isInstalling: false,
  lastInstallAt: null,
  lastResolvedDownloadUrl: null,
};

const fallbackTelemetry: ServerTelemetryResponse = {
  generatedAt: new Date(0).toISOString(),
  current: {
    state: 'stopped',
    cpuPercent: null,
    memoryMb: null,
    memoryPeakMb: null,
    playersOnline: 0,
    diskFreeGb: null,
    worldSizeMb: null,
  },
  kpis: {
    uptimePercent24h: 0,
    crashesToday: 0,
    restartsToday: 0,
    startsToday: 0,
    stopsToday: 0,
    joinsToday: 0,
    leavesToday: 0,
    peakPlayersToday: 0,
    startupTimeMsLast: null,
    startupTimeMsAvg: null,
    actionLatencyMsAvg: null,
    actionLatencyMsP95: null,
    apiLatencyMsAvg: null,
    apiLatencyMsP95: null,
    updateAgeDays: null,
  },
  trends: {
    last60m: [],
  },
  backup: {
    lastBackupAt: null,
    lastBackupDurationMs: null,
    failuresToday: 0,
    status: 'unknown',
  },
  network: {
    connectFailuresToday: 0,
    averageJoinLatencyMs: null,
  },
  retention: {
    rawSampleSeconds: 5,
    rawRetentionHours: 24,
    rollupRetentionDays: 90,
  },
  events: [],
  alerts: [],
};

function getDownloadDisplayName(entry: DownloadEntry): string {
  const previewNames = (entry.packs ?? []).map((pack) => pack.name).filter(Boolean);
  if (previewNames.length === 1) {
    return previewNames[0];
  }

  if (previewNames.length > 1) {
    return `${previewNames[0]} +${previewNames.length - 1}`;
  }

  return entry.filename
    .replace(/\.(mcpack|mcaddon)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function getTileTitleClass(label: string): string {
  const length = label.trim().length;
  if (length >= 38) {
    return ' pack-tile-name--tiny';
  }

  if (length >= 26) {
    return ' pack-tile-name--compact';
  }

  return '';
}

function getInstalledPacksForDownload(
  entry: DownloadEntry,
  behaviorPacks: BedrockPack[],
  resourcePacks: BedrockPack[],
): BedrockPack[] {
  const installedByKey = new Map<string, BedrockPack>([
    ...behaviorPacks.map((pack) => [`behavior:${pack.uuid}`, pack] as const),
    ...resourcePacks.map((pack) => [`resource:${pack.uuid}`, pack] as const),
  ]);

  return (entry.packs ?? [])
    .map((pack) => installedByKey.get(`${pack.type}:${pack.uuid}`))
    .filter((pack): pack is BedrockPack => Boolean(pack));
}

function isDownloadFullyInstalled(
  entry: DownloadEntry,
  behaviorPacks: BedrockPack[],
  resourcePacks: BedrockPack[],
): boolean {
  if (!entry.packs?.length) {
    return false;
  }

  return getInstalledPacksForDownload(entry, behaviorPacks, resourcePacks).length === entry.packs.length;
}

type AppDialogState =
  | {
      mode: 'input';
      title: string;
      message: string;
      value: string;
      confirmLabel: string;
      cancelLabel: string;
    }
  | {
      mode: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel: string;
    };

type AppToastState = {
  message: string;
  tone: 'success' | 'error';
};

function App() {
  const [selectedPage, setSelectedPage] = useState<LeftPage>('bedrock-edition');
  const [settingsTab, setSettingsTab] = useState<ServerSettingsTab>('server-status');
  const [apiHealthy, setApiHealthy] = useState<boolean>(false);
  const [status, setStatus] = useState<ServerStatusResponse>(fallbackStatus);
  const [, setLogs] = useState<LogEvent[]>([]);
  const [installerStatus, setInstallerStatus] =
    useState<InstallerStatusResponse>(fallbackInstallerStatus);
  const [telemetry, setTelemetry] = useState<ServerTelemetryResponse>(fallbackTelemetry);
  const [downloadUrl, setDownloadUrl] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [clockNow, setClockNow] = useState<number>(() => Date.now());
  const [offlineSinceMs, setOfflineSinceMs] = useState<number>(() => Date.now());

  // Properties form state
  const [propertiesForm, setPropertiesForm] = useState<BedrockServerProperties | null>(null);
  const [propertiesLoading, setPropertiesLoading] = useState<boolean>(false);
  const [propertiesDirty, setPropertiesDirty] = useState<boolean>(false);
  const [propertiesSaving, setPropertiesSaving] = useState<boolean>(false);
  const [propertiesSaveMsg, setPropertiesSaveMsg] = useState<string>('');
  const [propertiesError, setPropertiesError] = useState<string>('');
  const [propertiesPendingRestart, setPropertiesPendingRestart] = useState<boolean>(false);
  const propertiesLoadedRef = useRef<boolean>(false);

  // Packs (mods) state
  type FilesTab = 'behavior-packs' | 'resource-packs' | 'file-manager' | 'worlds' | 'mods-browser' | 'downloads';
  const [filesTab, setFilesTab] = useState<FilesTab>('behavior-packs');
  const [packsBehavior, setPacksBehavior] = useState<BedrockPack[]>([]);
  const [packsResource, setPacksResource] = useState<BedrockPack[]>([]);
  const [packsLoading, setPacksLoading] = useState<boolean>(false);
  const [packsError, setPacksError] = useState<string>('');
  const [packsBusy, setPacksBusy] = useState<Set<string>>(new Set());
  const [packsDragOver, setPacksDragOver] = useState<boolean>(false);
  const [packsUploadMsg, setPacksUploadMsg] = useState<string>('');
  const [packsUploading, setPacksUploading] = useState<boolean>(false);
  const packsLoadedRef = useRef<boolean>(false);
  const packUploadNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // File manager state
  const [fileEntries, setFileEntries] = useState<ServerFileEntry[]>([]);
  const [filePath, setFilePath] = useState<string>('.');
  const [fileParentPath, setFileParentPath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  const [fileBusyPaths, setFileBusyPaths] = useState<Set<string>>(new Set());
  const [fileError, setFileError] = useState<string>('');
  const [fileActionMsg, setFileActionMsg] = useState<string>('');
  const [fileDragOver, setFileDragOver] = useState<boolean>(false);
  const [editingFilePath, setEditingFilePath] = useState<string>('');
  const [editingFileContent, setEditingFileContent] = useState<string>('');
  const [editingFileDirty, setEditingFileDirty] = useState<boolean>(false);
  const [editingFileBusy, setEditingFileBusy] = useState<boolean>(false);
  const [fileUploading, setFileUploading] = useState<boolean>(false);
  const [fileSearch, setFileSearch] = useState<string>('');
  const [downloadEntries, setDownloadEntries] = useState<DownloadEntry[]>([]);
  const [downloadsLoading, setDownloadsLoading] = useState<boolean>(false);
  const [downloadsError, setDownloadsError] = useState<string>('');
  const [downloadsBusy, setDownloadsBusy] = useState<Set<string>>(new Set());
  const [downloadsInstallMsg, setDownloadsInstallMsg] = useState<string>('');
  const [activeWorldName, setActiveWorldName] = useState<string>('');
  const [activeWorldLoading, setActiveWorldLoading] = useState<boolean>(false);
  const [dialogState, setDialogState] = useState<AppDialogState | null>(null);
  const [toastState, setToastState] = useState<AppToastState | null>(null);
  const fileUploadNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogResolveRef = useRef<((value: string | boolean | null) => void) | null>(null);
  const modsWebviewRef = useRef<HTMLIFrameElement>(null);

  const stateClass = useMemo(() => `state-badge ${status.state}`, [status.state]);
  const isServerRunning = status.state === 'running';
  const runtimeClockClass = useMemo(
    () => `runtime-clock ${isServerRunning ? 'running' : 'offline'}`,
    [isServerRunning],
  );
  const lifecycleClockLabel = useMemo(() => {
    if (isServerRunning) {
      return formatDuration(status.uptimeMs);
    }

    return formatDuration(Math.max(0, clockNow - offlineSinceMs));
  }, [clockNow, isServerRunning, offlineSinceMs, status.uptimeMs]);
  const trendPoints = useMemo(() => telemetry.trends.last60m.slice(-20), [telemetry.trends.last60m]);
  const trendCpuMax = useMemo(() => {
    const values = trendPoints
      .map((point) => point.cpuPercent)
      .filter((value): value is number => value !== null);

    return Math.max(1, ...values);
  }, [trendPoints]);
  const trendMemoryMax = useMemo(() => {
    const values = trendPoints
      .map((point) => point.memoryMb)
      .filter((value): value is number => value !== null);

    return Math.max(1, ...values);
  }, [trendPoints]);
  const trendPlayersMax = useMemo(() => {
    const values = trendPoints.map((point) => point.playersOnline);
    return Math.max(1, ...values);
  }, [trendPoints]);
  const cpuPercent = Math.max(0, Math.min(100, telemetry.current.cpuPercent ?? 0));
  const memoryUsedMb = telemetry.current.memoryMb ?? 0;
  const memoryTotalMb = Math.max(memoryUsedMb, telemetry.current.memoryPeakMb ?? 2048);
  const memoryPercent = Math.max(0, Math.min(100, (memoryUsedMb / Math.max(memoryTotalMb, 1)) * 100));
  const playerCapacity = Math.max(20, telemetry.kpis.peakPlayersToday || 0);
  const playerPercent = Math.max(
    0,
    Math.min(100, (telemetry.current.playersOnline / Math.max(playerCapacity, 1)) * 100),
  );
  const diskFreeGb = telemetry.current.diskFreeGb ?? 0;
  const diskPercent = Math.max(0, Math.min(100, diskFreeGb));
  const isFileManagerTab = filesTab === 'file-manager';
  const isWorldsTab = filesTab === 'worlds';
  const isModsBrowserTab = filesTab === 'mods-browser';
  const isDownloadsTab = filesTab === 'downloads';
  const normalizedActiveWorld = activeWorldName.trim().toLowerCase();
  const isApiOnline = apiHealthy ? 'Online' : 'Offline';
  const gameplayPortStatus = isServerRunning ? 'Listening' : 'Standby';
  const queryPortStatus = isServerRunning ? 'Listening' : 'Standby';

  const showToast = useCallback((message: string, tone: AppToastState['tone']) => {
    if (!message.trim()) {
      return;
    }

    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }

    setToastState({ message, tone });
    toastTimerRef.current = setTimeout(() => {
      setToastState(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!fileActionMsg) return;
    showToast(fileActionMsg, 'success');
    setFileActionMsg('');
  }, [fileActionMsg, showToast]);

  useEffect(() => {
    if (!fileError) return;
    showToast(fileError, 'error');
    setFileError('');
  }, [fileError, showToast]);

  useEffect(() => {
    if (!downloadsInstallMsg) return;
    showToast(downloadsInstallMsg, 'success');
    setDownloadsInstallMsg('');
  }, [downloadsInstallMsg, showToast]);

  useEffect(() => {
    if (!downloadsError) return;
    showToast(downloadsError, 'error');
    setDownloadsError('');
  }, [downloadsError, showToast]);

  useEffect(() => {
    if (!packsUploadMsg) return;
    showToast(packsUploadMsg, 'success');
    setPacksUploadMsg('');
  }, [packsUploadMsg, showToast]);

  useEffect(() => {
    if (!packsError) return;
    showToast(packsError, 'error');
    setPacksError('');
  }, [packsError, showToast]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [health, serverStatus, currentInstallerStatus, nextTelemetry] = await Promise.all([
          fetchHealth(),
          fetchServerStatus(),
          fetchInstallerStatus(),
          fetchServerTelemetry(),
        ]);

        if (!active) {
          return;
        }

        setApiHealthy(health.ok);
        setStatus(serverStatus);
        setInstallerStatus(currentInstallerStatus);
        setTelemetry(nextTelemetry);
        setError('');
      } catch (cause) {
        if (!active) {
          return;
        }

        setApiHealthy(false);
        setError(cause instanceof Error ? cause.message : 'Failed to reach API');
      }
    };

    void load();
    const interval = setInterval(() => {
      void load();
    }, 3000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const close = connectLogs((event) => {
      setLogs((current) => [...current.slice(-80), event]);
    });

    return close;
  }, []);

  useEffect(() => {
    return () => {
      if (packUploadNoticeTimerRef.current) {
        clearTimeout(packUploadNoticeTimerRef.current);
      }

      if (fileUploadNoticeTimerRef.current) {
        clearTimeout(fileUploadNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (status.state !== 'running') {
      setOfflineSinceMs((current) => {
        return current || Date.now();
      });
      return;
    }

    setOfflineSinceMs(0);
  }, [status.state]);

  // Load packs when the server-files page is opened
  useEffect(() => {
    if (selectedPage !== 'server-files') return;
    if (packsLoadedRef.current) return;
    packsLoadedRef.current = true;
    setPacksLoading(true);
    fetchPacks()
      .then((result) => {
        setPacksBehavior(result.behaviorPacks);
        setPacksResource(result.resourcePacks);
        setPacksError('');
      })
      .catch((cause: unknown) => {
        setPacksError(cause instanceof Error ? cause.message : 'Failed to load packs');
      })
      .finally(() => setPacksLoading(false));
  }, [selectedPage]);

  const reloadPacks = () => {
    packsLoadedRef.current = false;
    setPacksLoading(true);
    fetchPacks()
      .then((result) => {
        packsLoadedRef.current = true;
        setPacksBehavior(result.behaviorPacks);
        setPacksResource(result.resourcePacks);
        setPacksError('');
      })
      .catch((cause: unknown) => {
        setPacksError(cause instanceof Error ? cause.message : 'Failed to reload packs');
      })
      .finally(() => setPacksLoading(false));
  };

  const textFileExt = useMemo(
    () => new Set(['txt', 'json', 'properties', 'mcfunction', 'yml', 'yaml', 'ini', 'cfg', 'xml', 'md', 'log']),
    [],
  );

  const canEditTextFile = useCallback(
    (name: string) => {
      const parts = name.toLowerCase().split('.');
      const ext = parts.length > 1 ? parts[parts.length - 1] : '';
      return textFileExt.has(ext);
    },
    [textFileExt],
  );

  const loadFileDirectory = useCallback(async (nextPath: string) => {
    setFileLoading(true);
    setFileError('');
    setFileSearch('');
    try {
      const payload = await fetchServerFiles(nextPath);
      setFileEntries(payload.entries);
      setFilePath(payload.currentPath);
      setFileParentPath(payload.parentPath);
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : 'Failed to load files');
    } finally {
      setFileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPage !== 'server-files') {
      return;
    }

    if (isFileManagerTab) {
      void loadFileDirectory(filePath);
      return;
    }

    if (isWorldsTab) {
      void loadFileDirectory('worlds');
    }
  }, [selectedPage, isFileManagerTab, isWorldsTab, filePath, loadFileDirectory]);

  useEffect(() => {
    if (selectedPage !== 'server-files' || !isWorldsTab) {
      return;
    }

    let active = true;
    setActiveWorldLoading(true);
    fetchServerProperties()
      .then((result) => {
        if (!active) {
          return;
        }

        setActiveWorldName(result.properties['level-name'].trim());
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setActiveWorldName('');
      })
      .finally(() => {
        if (active) {
          setActiveWorldLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedPage, isWorldsTab]);

  // Lock iframe navigation — iframes don't fire will-navigate, so we use
  // a beforeunload-style approach: reset src if the frame navigates away.
  useEffect(() => {
    if (!isModsBrowserTab) return;
    const iframe = modsWebviewRef.current;
    if (!iframe) return;

    const HOME = 'https://www.curseforge.com/minecraft-bedrock';
    const ALLOWED = 'https://www.curseforge.com/';

    const onLoad = () => {
      try {
        const loc = iframe.contentWindow?.location.href ?? '';
        if (loc && !loc.startsWith(ALLOWED)) {
          iframe.src = HOME;
        }
      } catch {
        // Cross-origin — location unreadable, Electron handles blocking via session.
      }
    };

    iframe.addEventListener('load', onLoad);
    return () => { iframe.removeEventListener('load', onLoad); };
  }, [isModsBrowserTab]);

  const loadDownloads = useCallback(async () => {
    setDownloadsLoading(true);
    setDownloadsError('');
    try {
      const res = await fetchDownloads();
      setDownloadEntries(res.entries);
    } catch (cause) {
      setDownloadsError(cause instanceof Error ? cause.message : 'Failed to load downloads');
    } finally {
      setDownloadsLoading(false);
    }
  }, []);

  const handleDeleteDownload = async (entry: DownloadEntry) => {
    const confirmed = await requestConfirm('Delete download', `Delete "${entry.filename}"?`);
    if (!confirmed) return;
    setDownloadsBusy((prev) => new Set([...prev, entry.filename]));
    try {
      await deleteDownload(entry.filename);
      setDownloadEntries((prev) => prev.filter((e) => e.filename !== entry.filename));
    } catch (cause) {
      setDownloadsError(cause instanceof Error ? cause.message : 'Failed to delete');
    } finally {
      setDownloadsBusy((prev) => { const next = new Set(prev); next.delete(entry.filename); return next; });
    }
  };

  const handleInstallDownload = async (entry: DownloadEntry) => {
    setDownloadsBusy((prev) => new Set([...prev, entry.filename]));
    setDownloadsInstallMsg('');
    setDownloadsError('');
    try {
      const result = await installFromDownloads(entry.filename);
      setDownloadsInstallMsg(result.message);
      reloadPacks();
      setTimeout(() => setDownloadsInstallMsg(''), 4000);
    } catch (cause) {
      setDownloadsError(cause instanceof Error ? cause.message : 'Failed to install');
    } finally {
      setDownloadsBusy((prev) => { const next = new Set(prev); next.delete(entry.filename); return next; });
    }
  };

  const handleUninstallDownload = async (entry: DownloadEntry) => {
    const installedPacks = getInstalledPacksForDownload(entry, packsBehavior, packsResource);
    if (installedPacks.length === 0) {
      return;
    }

    setDownloadsBusy((prev) => new Set([...prev, entry.filename]));
    setDownloadsInstallMsg('');
    setDownloadsError('');
    try {
      await Promise.all(installedPacks.map((pack) => deletePack(pack.type, pack.uuid)));

      const behaviorIds = new Set(
        installedPacks.filter((pack) => pack.type === 'behavior').map((pack) => pack.uuid),
      );
      const resourceIds = new Set(
        installedPacks.filter((pack) => pack.type === 'resource').map((pack) => pack.uuid),
      );

      if (behaviorIds.size > 0) {
        setPacksBehavior((prev) => prev.filter((pack) => !behaviorIds.has(pack.uuid)));
      }
      if (resourceIds.size > 0) {
        setPacksResource((prev) => prev.filter((pack) => !resourceIds.has(pack.uuid)));
      }

      setDownloadsInstallMsg(`Uninstalled ${installedPacks.length} pack(s) from ${entry.filename}`);
      setTimeout(() => setDownloadsInstallMsg(''), 4000);
    } catch (cause) {
      setDownloadsError(cause instanceof Error ? cause.message : 'Failed to uninstall');
    } finally {
      setDownloadsBusy((prev) => { const next = new Set(prev); next.delete(entry.filename); return next; });
    }
  };

  // Reload downloads when switching to downloads tab
  useEffect(() => {
    if (selectedPage === 'server-files' && isDownloadsTab) {
      void loadDownloads();
    }
  }, [selectedPage, isDownloadsTab, loadDownloads]);

  const openTextEditor = async (entry: ServerFileEntry) => {
    setEditingFileBusy(true);
    setFileActionMsg('');
    setFileError('');
    try {
      const payload = await readServerTextFile(entry.relativePath);
      setEditingFilePath(payload.path);
      setEditingFileContent(payload.content);
      setEditingFileDirty(false);
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : 'Failed to open file');
    } finally {
      setEditingFileBusy(false);
    }
  };

  const saveTextEditor = async () => {
    if (!editingFilePath) {
      return;
    }

    setEditingFileBusy(true);
    setFileActionMsg('');
    setFileError('');
    try {
      await writeServerTextFile(editingFilePath, editingFileContent);
      setEditingFileDirty(false);
      setFileActionMsg('File saved');
      await loadFileDirectory(filePath);
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : 'Failed to save file');
    } finally {
      setEditingFileBusy(false);
    }
  };

  const withFileBusy = async (targetPath: string, action: () => Promise<void>) => {
    setFileBusyPaths((current) => new Set([...current, targetPath]));
    setFileError('');
    setFileActionMsg('');
    try {
      await action();
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : 'File action failed');
    } finally {
      setFileBusyPaths((current) => {
        const next = new Set(current);
        next.delete(targetPath);
        return next;
      });
    }
  };

  const closeDialog = useCallback((value: string | boolean | null) => {
    const resolve = dialogResolveRef.current;
    dialogResolveRef.current = null;
    setDialogState(null);
    resolve?.(value);
  }, []);

  const requestInput = useCallback(
    (title: string, message: string, initialValue = ''): Promise<string | null> => {
      return new Promise((resolve) => {
        dialogResolveRef.current = (value) => {
          resolve(typeof value === 'string' ? value : null);
        };
        setDialogState({
          mode: 'input',
          title,
          message,
          value: initialValue,
          confirmLabel: 'Confirm',
          cancelLabel: 'Cancel',
        });
      });
    },
    [],
  );

  const requestConfirm = useCallback((title: string, message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      dialogResolveRef.current = (value) => {
        resolve(value === true);
      };
      setDialogState({
        mode: 'confirm',
        title,
        message,
        confirmLabel: 'Confirm',
        cancelLabel: 'Cancel',
      });
    });
  }, []);

  const handleCreateFolder = async () => {
    const nameRaw = await requestInput('Create folder', 'Enter a folder name');
    const name = nameRaw?.trim() ?? '';
    if (!name) {
      return;
    }

    await withFileBusy(`${filePath}/__new_folder__`, async () => {
      await createServerFolder(filePath, name);
      setFileActionMsg('Folder created');
      await loadFileDirectory(filePath);
    });
  };

  const handleRenameItem = async (entry: ServerFileEntry) => {
    const newNameRaw = await requestInput('Rename item', `Rename "${entry.name}" to:`, entry.name);
    const newName = newNameRaw?.trim() ?? '';
    if (!newName || newName === entry.name) {
      return;
    }

    await withFileBusy(entry.relativePath, async () => {
      await renameServerPath(entry.relativePath, newName);
      if (editingFilePath === entry.relativePath) {
        setEditingFilePath('');
        setEditingFileContent('');
        setEditingFileDirty(false);
      }
      setFileActionMsg('Item renamed');
      await loadFileDirectory(filePath);
    });
  };

  const handleDeleteItem = async (entry: ServerFileEntry) => {
    const confirmed = await requestConfirm(
      'Delete item',
      `Delete ${entry.kind} "${entry.name}"? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    await withFileBusy(entry.relativePath, async () => {
      await deleteServerPath(entry.relativePath);
      if (editingFilePath === entry.relativePath) {
        setEditingFilePath('');
        setEditingFileContent('');
        setEditingFileDirty(false);
      }
      setFileActionMsg('Item deleted');
      await loadFileDirectory(filePath);
    });
  };

  const handleFileUpload = async (files: FileList | null, targetPath?: string) => {
    if (!files || files.length === 0 || fileUploading) {
      return;
    }

    const uploadPath = targetPath ?? filePath;
    const file = files[0];
    setFileUploading(true);
    setFileActionMsg('');
    setFileError('');

    if (fileUploadNoticeTimerRef.current) {
      clearTimeout(fileUploadNoticeTimerRef.current);
      fileUploadNoticeTimerRef.current = null;
    }

    try {
      await uploadServerFile(uploadPath, file);
      setFileActionMsg(`Uploaded ${file.name} to /${uploadPath === '.' ? '' : uploadPath}`);
      await loadFileDirectory(uploadPath);
      fileUploadNoticeTimerRef.current = setTimeout(() => {
        setFileActionMsg('');
      }, 4000);
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : 'Failed to upload file');
      fileUploadNoticeTimerRef.current = setTimeout(() => {
        setFileError('');
      }, 5000);
    } finally {
      setFileUploading(false);
    }
  };

  const handlePackToggle = async (pack: BedrockPack) => {
    const newActive = !pack.active;
    // Find a paired pack in the other list with the same name (BP↔RP from the same addon)
    const otherList = pack.type === 'behavior' ? packsResource : packsBehavior;
    const paired = otherList.find((p) => p.name === pack.name && p.active !== newActive);

    const keys = [pack.uuid, ...(paired ? [paired.uuid] : [])];
    setPacksBusy((prev) => new Set([...prev, ...keys]));
    try {
      const ops: Promise<unknown>[] = [togglePack(pack.type, pack.uuid, newActive)];
      if (paired) ops.push(togglePack(paired.type, paired.uuid, newActive));
      await Promise.all(ops);

      const makeUpdater = (uuid: string) => (prev: BedrockPack[]) =>
        prev.map((p) => (p.uuid === uuid ? { ...p, active: newActive } : p));
      if (pack.type === 'behavior') {
        setPacksBehavior(makeUpdater(pack.uuid));
        if (paired) setPacksResource(makeUpdater(paired.uuid));
      } else {
        setPacksResource(makeUpdater(pack.uuid));
        if (paired) setPacksBehavior(makeUpdater(paired.uuid));
      }
    } catch (cause) {
      setPacksError(cause instanceof Error ? cause.message : 'Failed to toggle pack');
    } finally {
      setPacksBusy((prev) => { const next = new Set(prev); for (const k of keys) next.delete(k); return next; });
    }
  };

  const handlePackDelete = async (pack: BedrockPack) => {
    const confirmed = await requestConfirm('Delete pack', `Delete pack "${pack.name}"? This cannot be undone.`);
    if (!confirmed) return;
    const key = pack.uuid;
    setPacksBusy((prev) => new Set([...prev, key]));
    try {
      await deletePack(pack.type, pack.uuid);
      if (pack.type === 'behavior') setPacksBehavior((prev) => prev.filter((p) => p.uuid !== pack.uuid));
      else setPacksResource((prev) => prev.filter((p) => p.uuid !== pack.uuid));
    } catch (cause) {
      setPacksError(cause instanceof Error ? cause.message : 'Failed to delete pack');
    } finally {
      setPacksBusy((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  const handlePackUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || packsUploading) return;
    setPacksUploadMsg('');
    setPacksError('');

    setPacksUploading(true);
    if (packUploadNoticeTimerRef.current) {
      clearTimeout(packUploadNoticeTimerRef.current);
      packUploadNoticeTimerRef.current = null;
    }

    try {
      const result = await uploadPacks(files);
      setPacksUploadMsg(result.message);
      reloadPacks();
      packUploadNoticeTimerRef.current = setTimeout(() => {
        setPacksUploadMsg('');
      }, 4000);
    } catch (cause) {
      setPacksError(cause instanceof Error ? cause.message : 'Failed to upload pack');
      packUploadNoticeTimerRef.current = setTimeout(() => {
        setPacksError('');
      }, 5000);
    } finally {
      setPacksUploading(false);
    }
  };

  // Load server properties when the properties tab becomes active (once)
  useEffect(() => {
    if (selectedPage !== 'server-settings' || settingsTab !== 'properties') return;
    if (propertiesLoadedRef.current) return;
    propertiesLoadedRef.current = true;
    setPropertiesLoading(true);
    fetchServerProperties()
      .then((result) => {
        setPropertiesForm(result.properties);
        setPropertiesDirty(false);
        setPropertiesError('');
      })
      .catch((cause: unknown) => {
        setPropertiesError(cause instanceof Error ? cause.message : 'Failed to load properties');
      })
      .finally(() => setPropertiesLoading(false));
  }, [selectedPage, settingsTab]);

  const setProp = useCallback(
    <K extends keyof BedrockServerProperties>(key: K, value: BedrockServerProperties[K]) => {
      setPropertiesForm((prev) => (prev ? { ...prev, [key]: value } : prev));
      setPropertiesDirty(true);
      setPropertiesSaveMsg('');
    },
    [],
  );

  const saveProperties = async () => {
    if (!propertiesForm) return;
    setPropertiesSaving(true);
    try {
      const result = await updateServerProperties(propertiesForm);
      setPropertiesDirty(false);
      setPropertiesSaveMsg(result.message);
      setPropertiesPendingRestart(true);
      setPropertiesError('');
    } catch (cause) {
      setPropertiesError(cause instanceof Error ? cause.message : 'Failed to save properties');
    } finally {
      setPropertiesSaving(false);
    }
  };

  const reloadProperties = () => {
    propertiesLoadedRef.current = false;
    setPropertiesForm(null);
    setPropertiesDirty(false);
    setPropertiesSaveMsg('');
    setPropertiesError('');
    // Trigger the effect by toggling — force re-run by resetting the ref then calling the effect
    setPropertiesLoading(true);
    fetchServerProperties()
      .then((result) => {
        propertiesLoadedRef.current = true;
        setPropertiesForm(result.properties);
        setPropertiesDirty(false);
        setPropertiesError('');
      })
      .catch((cause: unknown) => {
        setPropertiesError(cause instanceof Error ? cause.message : 'Failed to reload properties');
      })
      .finally(() => setPropertiesLoading(false));
  };

  const runAction = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    try {
      await postServerAction(action);
      setLogs((current) => [
        ...current.slice(-80),
        {
          kind: 'log',
          at: new Date().toISOString(),
          line: `Action accepted: ${action}`,
        },
      ]);
      const nextStatus = await fetchServerStatus();
      const nextInstallerStatus = await fetchInstallerStatus();
      const nextTelemetry = await fetchServerTelemetry();
      setStatus(nextStatus);
      setInstallerStatus(nextInstallerStatus);
      setTelemetry(nextTelemetry);
      setError('');
      setPropertiesPendingRestart(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed action: ${action}`);
    } finally {
      setBusy(false);
    }
  };

  const runInstall = async () => {
    setBusy(true);
    try {
      const response = await postInstallerInstall(downloadUrl);
      setLogs((current) => [
        ...current.slice(-80),
        {
          kind: 'log',
          at: new Date().toISOString(),
          line: response.message,
        },
      ]);
      const [nextStatus, nextInstallerStatus] = await Promise.all([
        fetchServerStatus(),
        fetchInstallerStatus(),
      ]);
      const nextTelemetry = await fetchServerTelemetry();
      setStatus(nextStatus);
      setInstallerStatus(nextInstallerStatus);
      setTelemetry(nextTelemetry);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to install Bedrock server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="launcher-shell">
      <aside className="launcher-sidebar">
        <div className="account-box">
          <div className="avatar">T</div>
          <div>
            <p className="account-name">Toxic Hugs</p>
            <p className="account-sub">Launcher Account</p>
          </div>
        </div>

        <div className="left-links">
          {leftPages.map((page) => (
            <button
              className={page.id === selectedPage ? 'left-link selected' : 'left-link'}
              key={page.id}
              onClick={() => setSelectedPage(page.id)}
              type="button"
            >
              {page.label}
            </button>
          ))}
        </div>

        <div className="left-footer">
          <button className="left-link" type="button">What's New</button>
          <button className="left-link" type="button">Settings</button>
        </div>
      </aside>

      <main className="launcher-main">
        <header className="topbar">
          <div className="header-brand">
            <p className="top-label">Minecraft Launcher</p>
            <h1>Bedrock Panel Launcher</h1>
          </div>

          <div className="header-actions">
            <button type="button" onClick={() => void runAction('start')} disabled={busy}>
              Start
            </button>
            <button type="button" onClick={() => void runAction('stop')} disabled={busy}>
              Stop
            </button>
            <button type="button" onClick={() => void runAction('restart')} disabled={busy}>
              Restart
            </button>
            {propertiesPendingRestart ? (
              <div className="pending-restart-badge" role="status">
                <span className="pending-restart-icon">!</span>
                <span className="pending-restart-tooltip">
                  Server properties have been saved. Restart the server for changes to take effect.
                </span>
              </div>
            ) : null}
          </div>

          <div className="header-status">
            <p className={runtimeClockClass}>{lifecycleClockLabel}</p>
            <div className={stateClass}>{stateLabel[status.state]}</div>
          </div>
        </header>

        {selectedPage === 'bedrock-edition' ? (
          <>
            <section className="hero">
              <div className="hero-overlay">
                <h2>Minecraft: Bedrock Edition</h2>
                {error ? <p className="error">{error}</p> : null}
              </div>
            </section>

            <section className="resource-telemetry-section metrics-layout-control-deck">
              <div className="resource-telemetry-header">
                <h3>Metrics and Status</h3>
                <p>Live resource telemetry for Bedrock runtime.</p>
              </div>

              <div className="resource-grid">
                <article className="resource-card cpu">
                  <h4>CPU Usage</h4>
                  <p>{formatMetric(telemetry.current.cpuPercent, 1)}%</p>
                  <div
                    className="resource-ring"
                    style={{
                      background: `conic-gradient(#d9ffe1 ${cpuPercent}%, rgba(0, 0, 0, 0.24) ${cpuPercent}% 100%)`,
                    }}
                  >
                    <i />
                  </div>
                </article>

                <article className="resource-card memory">
                  <h4>Memory Usage</h4>
                  <p>
                    {formatMetric(memoryUsedMb / 1024, 2)} / {formatMetric(memoryTotalMb / 1024, 2)} GB
                  </p>
                  <div
                    className="resource-ring"
                    style={{
                      background: `conic-gradient(#e8f3ff ${memoryPercent}%, rgba(0, 0, 0, 0.24) ${memoryPercent}% 100%)`,
                    }}
                  >
                    <i />
                  </div>
                </article>

                <article className="resource-card players">
                  <h4>Active Users</h4>
                  <p>
                    {telemetry.current.playersOnline} / {playerCapacity}
                  </p>
                  <div
                    className="resource-ring"
                    style={{
                      background: `conic-gradient(#f4e3ff ${playerPercent}%, rgba(0, 0, 0, 0.24) ${playerPercent}% 100%)`,
                    }}
                  >
                    <i />
                  </div>
                </article>

                <article className="resource-card disk">
                  <h4>Disk Free</h4>
                  <p>{formatMetric(telemetry.current.diskFreeGb, 2)} GB</p>
                  <div
                    className="resource-ring"
                    style={{
                      background: `conic-gradient(#fff0da ${diskPercent}%, rgba(0, 0, 0, 0.24) ${diskPercent}% 100%)`,
                    }}
                  >
                    <i />
                  </div>
                  <span>World: {formatMetric(telemetry.current.worldSizeMb, 1)} MB</span>
                </article>
              </div>

              <section className="control-deck-lower" aria-label="Control deck status">
                <article className="deck-panel actions">
                  <h4>Actions</h4>
                  <div className="deck-chip-row">
                    <button type="button" onClick={() => void runAction('restart')} disabled={busy}>
                      Restart
                    </button>
                    <button type="button" onClick={() => void runAction('stop')} disabled={busy}>
                      Stop
                    </button>
                  </div>
                </article>

                <article className="deck-panel connection">
                  <h4>Connection</h4>
                  <p>API Reachable: {isApiOnline}</p>
                  <p>Join Latency: {formatMs(telemetry.network.averageJoinLatencyMs)}</p>
                  <p>Connect Failures Today: {telemetry.network.connectFailuresToday}</p>
                </article>

                <article className="deck-panel network">
                  <h4>Network Ports</h4>
                  <p>
                    <span className={`port-pill ${isServerRunning ? 'live' : 'standby'}`}>19132 {gameplayPortStatus}</span>
                  </p>
                  <p>
                    <span className={`port-pill ${isServerRunning ? 'live' : 'standby'}`}>19133 {queryPortStatus}</span>
                  </p>
                </article>
              </section>
            </section>

            <section className="play-rail">
              <div className="release-box rail-spacer" aria-hidden="true" />

              <button
                className="play-button"
                type="button"
                onClick={() => void runAction('start')}
                disabled={busy}
              >
                PLAY
              </button>

              <div className="identity-box rail-spacer" aria-hidden="true" />
            </section>
          </>
        ) : null}

        {selectedPage === 'home' ? (
          <section className="placeholder-wrap">
            <h3>Home (Test Page)</h3>
            <p>Placeholder content for future home dashboard experiments.</p>
          </section>
        ) : null}

        {selectedPage === 'java-edition' ? (
          <section className="placeholder-wrap">
            <h3>Minecraft: Java Edition</h3>
            <p>Placeholder page reserved for future Java-specific controls.</p>
          </section>
        ) : null}

        {selectedPage === 'test' ? (
          <TestPage />
        ) : null}

        {selectedPage === 'server-settings' ? (
          <section className="server-settings-wrap">
            <h3>Server Settings</h3>
            <div className="settings-tabs" role="tablist" aria-label="Server settings tabs">
              <button
                className={settingsTab === 'server-status' ? 'settings-tab active' : 'settings-tab'}
                onClick={() => setSettingsTab('server-status')}
                type="button"
              >
                Server Status
              </button>
              <button
                className={settingsTab === 'properties' ? 'settings-tab active' : 'settings-tab'}
                onClick={() => setSettingsTab('properties')}
                type="button"
              >
                Server Properties
              </button>
              <button
                className={settingsTab === 'general' ? 'settings-tab active' : 'settings-tab'}
                onClick={() => setSettingsTab('general')}
                type="button"
              >
                General
              </button>
            </div>

            {settingsTab === 'server-status' ? (
              <div className="settings-panel" role="tabpanel" aria-label="Server status">
                <section className="props-section">
                  <h4 className="props-section-title">Service and Network</h4>
                  <div className="props-grid status-grid">
                    <div className="prop-row status-row">
                      <span className="prop-label">Server State</span>
                      <span className="prop-hint">Current Bedrock process lifecycle state</span>
                      <span className={`status-value-pill ${apiHealthy ? 'ok' : 'warn'}`}>
                        {stateLabel[telemetry.current.state]}
                      </span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">API Reachable</span>
                      <span className="prop-hint">Panel connectivity to local API service</span>
                      <span className={`status-value-pill ${apiHealthy ? 'ok' : 'warn'}`}>
                        {apiHealthy ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Join Latency</span>
                      <span className="prop-hint">Average player join response time</span>
                      <span className="status-value">{formatMs(telemetry.network.averageJoinLatencyMs)}</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Connect Failures Today</span>
                      <span className="prop-hint">Failed player connection attempts</span>
                      <span className="status-value">{telemetry.network.connectFailuresToday}</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Action Latency</span>
                      <span className="prop-hint">Avg/P95 command latency for lifecycle actions</span>
                      <span className="status-value">
                        {formatMs(telemetry.kpis.actionLatencyMsAvg)} / {formatMs(telemetry.kpis.actionLatencyMsP95)}
                      </span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">API Latency</span>
                      <span className="prop-hint">Avg/P95 API request latency</span>
                      <span className="status-value">
                        {formatMs(telemetry.kpis.apiLatencyMsAvg)} / {formatMs(telemetry.kpis.apiLatencyMsP95)}
                      </span>
                    </div>
                  </div>
                </section>

                <section className="props-section">
                  <h4 className="props-section-title">Resources</h4>
                  <div className="props-grid status-grid">
                    <div className="prop-row status-row">
                      <span className="prop-label">CPU Usage</span>
                      <span className="prop-hint">Current process CPU load</span>
                      <span className="status-value">{formatMetric(telemetry.current.cpuPercent, 1)}%</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">RAM Usage</span>
                      <span className="prop-hint">Current / peak memory consumption</span>
                      <span className="status-value">
                        {formatMetric(telemetry.current.memoryMb, 0)} MB / {formatMetric(telemetry.current.memoryPeakMb, 0)} MB
                      </span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Disk Free</span>
                      <span className="prop-hint">Free storage available on server drive</span>
                      <span className="status-value">{formatMetric(telemetry.current.diskFreeGb, 2)} GB</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">World Size</span>
                      <span className="prop-hint">Total size of the worlds directory</span>
                      <span className="status-value">{formatMetric(telemetry.current.worldSizeMb, 1)} MB</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Players Online</span>
                      <span className="prop-hint">Current concurrent players</span>
                      <span className="status-value">{telemetry.current.playersOnline}</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Peak Players Today</span>
                      <span className="prop-hint">Highest concurrent session count today</span>
                      <span className="status-value">{telemetry.kpis.peakPlayersToday}</span>
                    </div>
                  </div>
                </section>

                <section className="props-section">
                  <h4 className="props-section-title">Activity and Reliability</h4>
                  <div className="props-grid status-grid">
                    <div className="prop-row status-row">
                      <span className="prop-label">Uptime (24h)</span>
                      <span className="prop-hint">Rolling uptime percentage over last 24 hours</span>
                      <span className="status-value">{formatMetric(telemetry.kpis.uptimePercent24h, 1)}%</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Crashes Today</span>
                      <span className="prop-hint">Unexpected process exits for current day</span>
                      <span className="status-value">{telemetry.kpis.crashesToday}</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Starts / Stops / Restarts</span>
                      <span className="prop-hint">Lifecycle action counters for today</span>
                      <span className="status-value">
                        {telemetry.kpis.startsToday} / {telemetry.kpis.stopsToday} / {telemetry.kpis.restartsToday}
                      </span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Joins / Leaves</span>
                      <span className="prop-hint">Player session events for today</span>
                      <span className="status-value">
                        {telemetry.kpis.joinsToday} / {telemetry.kpis.leavesToday}
                      </span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Startup Time</span>
                      <span className="prop-hint">Last / average startup duration</span>
                      <span className="status-value">
                        {formatMs(telemetry.kpis.startupTimeMsLast)} / {formatMs(telemetry.kpis.startupTimeMsAvg)}
                      </span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Backup Health</span>
                      <span className="prop-hint">
                        {telemetry.backup.lastBackupAt
                          ? `Last backup ${new Date(telemetry.backup.lastBackupAt).toLocaleString()}`
                          : 'No backup timestamp available'}
                      </span>
                      <span className={`status-value-pill ${telemetry.backup.status === 'healthy' ? 'ok' : 'warn'}`}>
                        {telemetry.backup.status.toUpperCase()} ({telemetry.backup.failuresToday} fails)
                      </span>
                    </div>
                  </div>
                </section>

                <section className="props-section">
                  <h4 className="props-section-title">Resource Trends (Last 60m)</h4>
                  {trendPoints.length === 0 ? (
                    <p className="status-empty">No telemetry samples yet. Keep this tab open for a minute.</p>
                  ) : (
                    <div className="telemetry-chart-grid">
                      <div className="telemetry-chart">
                        <span>CPU %</span>
                        <div className="sparkline">
                          {trendPoints.map((point) => (
                            <i
                              key={`cpu-${point.at}`}
                              style={{ height: `${Math.max(8, ((point.cpuPercent ?? 0) / trendCpuMax) * 100)}%` }}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="telemetry-chart">
                        <span>RAM MB</span>
                        <div className="sparkline">
                          {trendPoints.map((point) => (
                            <i
                              key={`ram-${point.at}`}
                              style={{
                                height: `${Math.max(8, ((point.memoryMb ?? 0) / trendMemoryMax) * 100)}%`,
                              }}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="telemetry-chart">
                        <span>Players</span>
                        <div className="sparkline">
                          {trendPoints.map((point) => (
                            <i
                              key={`players-${point.at}`}
                              style={{
                                height: `${Math.max(8, (point.playersOnline / trendPlayersMax) * 100)}%`,
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </section>

                <div className="status-bottom-grid">
                  <section className="props-section">
                    <h4 className="props-section-title">Active Alerts</h4>
                    {telemetry.alerts.length === 0 ? (
                      <p className="status-empty">No active alerts.</p>
                    ) : (
                      <div className="telemetry-list">
                        {telemetry.alerts.map((alert) => (
                          <p key={alert.id}>
                            [{alert.severity.toUpperCase()}] {alert.message} (since{' '}
                            {new Date(alert.startedAt).toLocaleTimeString()})
                          </p>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="props-section">
                    <h4 className="props-section-title">Telemetry Events</h4>
                    {telemetry.events.length === 0 ? (
                      <p className="status-empty">No events yet.</p>
                    ) : (
                      <div className="telemetry-list">
                        {telemetry.events.slice(0, 20).map((event, index) => (
                          <p key={`${event.at}-${index}`}>
                            {new Date(event.at).toLocaleTimeString()} [{event.category}] {event.message}
                          </p>
                        ))}
                      </div>
                    )}
                  </section>
                </div>

                <section className="props-section">
                  <h4 className="props-section-title">Telemetry Retention</h4>
                  <div className="props-grid status-grid">
                    <div className="prop-row status-row">
                      <span className="prop-label">Raw Sample Interval</span>
                      <span className="prop-hint">How frequently new runtime samples are captured</span>
                      <span className="status-value">Every {telemetry.retention.rawSampleSeconds}s</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Raw Retention Window</span>
                      <span className="prop-hint">Duration of high-resolution retained metrics</span>
                      <span className="status-value">{telemetry.retention.rawRetentionHours}h</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Rollup Retention Window</span>
                      <span className="prop-hint">Duration of aggregated historical metrics</span>
                      <span className="status-value">{telemetry.retention.rollupRetentionDays}d</span>
                    </div>
                    <div className="prop-row status-row">
                      <span className="prop-label">Update Age</span>
                      <span className="prop-hint">Days since server binaries were last refreshed</span>
                      <span className="status-value">{formatMetric(telemetry.kpis.updateAgeDays, 0)} days</span>
                    </div>
                  </div>
                </section>
              </div>
            ) : null}

            {settingsTab === 'properties' ? (
              <div className="settings-panel" role="tabpanel" aria-label="Server Properties">
                {propertiesLoading ? (
                  <p className="dim">Loading server.properties...</p>
                ) : propertiesError && !propertiesForm ? (
                  <div className="props-error">
                    <p>Error: {propertiesError}</p>
                    <button type="button" onClick={reloadProperties}>Retry</button>
                  </div>
                ) : propertiesForm ? (
                  <>
                    {status.state === 'running' ? (
                      <div className="props-notice warn">
                        Server is running — changes will take effect after the next restart.
                      </div>
                    ) : null}
                    {propertiesSaveMsg ? (
                      <div className="props-notice success">{propertiesSaveMsg}</div>
                    ) : null}
                    {propertiesError ? (
                      <div className="props-notice error">{propertiesError}</div>
                    ) : null}

                    {/* ── General ── */}
                    <section className="props-section">
                      <h4 className="props-section-title">General</h4>
                      <div className="props-grid">
                        <label className="prop-row">
                          <span className="prop-label">Server Name</span>
                          <input
                            className="prop-input"
                            type="text"
                            value={propertiesForm['server-name']}
                            onChange={(e) => setProp('server-name', e.target.value)}
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Level Name</span>
                          <input
                            className="prop-input"
                            type="text"
                            value={propertiesForm['level-name']}
                            onChange={(e) => setProp('level-name', e.target.value)}
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Level Seed</span>
                          <input
                            className="prop-input"
                            type="text"
                            value={propertiesForm['level-seed']}
                            placeholder="(blank = random)"
                            onChange={(e) => setProp('level-seed', e.target.value)}
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Gamemode</span>
                          <select
                            className="prop-select"
                            value={propertiesForm.gamemode}
                            onChange={(e) =>
                              setProp(
                                'gamemode',
                                e.target.value as BedrockServerProperties['gamemode'],
                              )
                            }
                          >
                            <option value="survival">Survival</option>
                            <option value="creative">Creative</option>
                            <option value="adventure">Adventure</option>
                          </select>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Difficulty</span>
                          <select
                            className="prop-select"
                            value={propertiesForm.difficulty}
                            onChange={(e) =>
                              setProp(
                                'difficulty',
                                e.target.value as BedrockServerProperties['difficulty'],
                              )
                            }
                          >
                            <option value="peaceful">Peaceful</option>
                            <option value="easy">Easy</option>
                            <option value="normal">Normal</option>
                            <option value="hard">Hard</option>
                          </select>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Max Players</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={1}
                            max={30}
                            value={propertiesForm['max-players']}
                            onChange={(e) =>
                              setProp('max-players', parseInt(e.target.value, 10) || 1)
                            }
                          />
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Force Gamemode</span>
                          <span className="prop-hint">Force gamemode on all players each join</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['force-gamemode'] ? ' on' : ''}`}
                            onClick={() => setProp('force-gamemode', !propertiesForm['force-gamemode'])}
                            aria-pressed={propertiesForm['force-gamemode']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                      </div>
                    </section>

                    {/* ── Access & Security ── */}
                    <section className="props-section">
                      <h4 className="props-section-title">Access &amp; Security</h4>
                      <div className="props-grid">
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Online Mode</span>
                          <span className="prop-hint">Require Xbox Live auth (recommended on)</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['online-mode'] ? ' on' : ''}`}
                            onClick={() => setProp('online-mode', !propertiesForm['online-mode'])}
                            aria-pressed={propertiesForm['online-mode']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Allow Cheats</span>
                          <span className="prop-hint">Enable command cheat codes</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['allow-cheats'] ? ' on' : ''}`}
                            onClick={() => setProp('allow-cheats', !propertiesForm['allow-cheats'])}
                            aria-pressed={propertiesForm['allow-cheats']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Allow List</span>
                          <span className="prop-hint">Only allowlisted players may join</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['allow-list'] ? ' on' : ''}`}
                            onClick={() => setProp('allow-list', !propertiesForm['allow-list'])}
                            aria-pressed={propertiesForm['allow-list']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Require Texture Pack</span>
                          <span className="prop-hint">Force clients to use the world texture pack</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['texturepack-required'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp('texturepack-required', !propertiesForm['texturepack-required'])
                            }
                            aria-pressed={propertiesForm['texturepack-required']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Default Permission Level</span>
                          <select
                            className="prop-select"
                            value={propertiesForm['default-player-permission-level']}
                            onChange={(e) =>
                              setProp(
                                'default-player-permission-level',
                                e.target.value as BedrockServerProperties['default-player-permission-level'],
                              )
                            }
                          >
                            <option value="visitor">Visitor</option>
                            <option value="member">Member</option>
                            <option value="operator">Operator</option>
                          </select>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Chat Restriction</span>
                          <select
                            className="prop-select"
                            value={propertiesForm['chat-restriction']}
                            onChange={(e) =>
                              setProp(
                                'chat-restriction',
                                e.target.value as BedrockServerProperties['chat-restriction'],
                              )
                            }
                          >
                            <option value="None">None (free chat)</option>
                            <option value="Dropped">Dropped (silently discarded)</option>
                            <option value="Disabled">Disabled (UI hidden)</option>
                          </select>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Disable Custom Skins</span>
                          <span className="prop-hint">Block non-store player skins</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['disable-custom-skins'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp('disable-custom-skins', !propertiesForm['disable-custom-skins'])
                            }
                            aria-pressed={propertiesForm['disable-custom-skins']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Idle Kick Timeout</span>
                          <span className="prop-hint">Minutes before idle players are kicked (0 = never)</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={0}
                            value={propertiesForm['player-idle-timeout']}
                            onChange={(e) =>
                              setProp('player-idle-timeout', parseInt(e.target.value, 10) || 0)
                            }
                          />
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Disable Player Interaction</span>
                          <span className="prop-hint">Clients ignore other players in-world</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['disable-player-interaction'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'disable-player-interaction',
                                !propertiesForm['disable-player-interaction'],
                              )
                            }
                            aria-pressed={propertiesForm['disable-player-interaction']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                      </div>
                    </section>

                    {/* ── Network ── */}
                    <section className="props-section">
                      <h4 className="props-section-title">Network</h4>
                      <div className="props-grid">
                        <label className="prop-row">
                          <span className="prop-label">IPv4 Port</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={1}
                            max={65535}
                            value={propertiesForm['server-port']}
                            onChange={(e) =>
                              setProp('server-port', parseInt(e.target.value, 10) || 19132)
                            }
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">IPv6 Port</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={1}
                            max={65535}
                            value={propertiesForm['server-portv6']}
                            onChange={(e) =>
                              setProp('server-portv6', parseInt(e.target.value, 10) || 19133)
                            }
                          />
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">LAN Visibility</span>
                          <span className="prop-hint">Respond to LAN discovery broadcasts</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['enable-lan-visibility'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp('enable-lan-visibility', !propertiesForm['enable-lan-visibility'])
                            }
                            aria-pressed={propertiesForm['enable-lan-visibility']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Compression Threshold</span>
                          <span className="prop-hint">Min bytes before packet is compressed (0–65535)</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={0}
                            max={65535}
                            value={propertiesForm['compression-threshold']}
                            onChange={(e) =>
                              setProp('compression-threshold', parseInt(e.target.value, 10) || 0)
                            }
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Compression Algorithm</span>
                          <select
                            className="prop-select"
                            value={propertiesForm['compression-algorithm']}
                            onChange={(e) =>
                              setProp(
                                'compression-algorithm',
                                e.target.value as BedrockServerProperties['compression-algorithm'],
                              )
                            }
                          >
                            <option value="zlib">zlib</option>
                            <option value="snappy">snappy</option>
                          </select>
                        </label>
                      </div>
                    </section>

                    {/* ── Performance / World ── */}
                    <section className="props-section">
                      <h4 className="props-section-title">Performance &amp; World</h4>
                      <div className="props-grid">
                        <label className="prop-row">
                          <span className="prop-label">View Distance</span>
                          <span className="prop-hint">Max chunks visible (≥5, higher = more RAM)</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={5}
                            value={propertiesForm['view-distance']}
                            onChange={(e) =>
                              setProp('view-distance', Math.max(5, parseInt(e.target.value, 10) || 32))
                            }
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Tick Distance</span>
                          <span className="prop-hint">Active simulation radius in chunks (4–12)</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={4}
                            max={12}
                            value={propertiesForm['tick-distance']}
                            onChange={(e) =>
                              setProp(
                                'tick-distance',
                                Math.min(12, Math.max(4, parseInt(e.target.value, 10) || 4)),
                              )
                            }
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Max Threads</span>
                          <span className="prop-hint">Server thread cap (0 = all available)</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={0}
                            value={propertiesForm['max-threads']}
                            onChange={(e) =>
                              setProp('max-threads', parseInt(e.target.value, 10) || 0)
                            }
                          />
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Client-side Chunk Gen</span>
                          <span className="prop-hint">Clients generate visual chunks beyond render distance</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['client-side-chunk-generation-enabled'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'client-side-chunk-generation-enabled',
                                !propertiesForm['client-side-chunk-generation-enabled'],
                              )
                            }
                            aria-pressed={propertiesForm['client-side-chunk-generation-enabled']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Block Network ID Hashes</span>
                          <span className="prop-hint">Use stable hashed block IDs (recommended on)</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['block-network-ids-are-hashes'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'block-network-ids-are-hashes',
                                !propertiesForm['block-network-ids-are-hashes'],
                              )
                            }
                            aria-pressed={propertiesForm['block-network-ids-are-hashes']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                      </div>
                    </section>

                    {/* ── Anti-Cheat / Movement ── */}
                    <section className="props-section">
                      <h4 className="props-section-title">Anti-Cheat &amp; Movement Validation</h4>
                      <div className="props-grid">
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Strict Movement</span>
                          <span className="prop-hint">Send more position corrections to clients</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['server-authoritative-movement-strict'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'server-authoritative-movement-strict',
                                !propertiesForm['server-authoritative-movement-strict'],
                              )
                            }
                            aria-pressed={propertiesForm['server-authoritative-movement-strict']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Strict Dismount</span>
                          <span className="prop-hint">Correct dismount position at high latency</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['server-authoritative-dismount-strict'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'server-authoritative-dismount-strict',
                                !propertiesForm['server-authoritative-dismount-strict'],
                              )
                            }
                            aria-pressed={propertiesForm['server-authoritative-dismount-strict']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Strict Entity Interactions</span>
                          <span className="prop-hint">Stricter entity interaction checks for players</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['server-authoritative-entity-interactions-strict'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'server-authoritative-entity-interactions-strict',
                                !propertiesForm['server-authoritative-entity-interactions-strict'],
                              )
                            }
                            aria-pressed={propertiesForm['server-authoritative-entity-interactions-strict']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Position Acceptance Threshold</span>
                          <span className="prop-hint">Max pos discrepancy before correction (0.0–1.0)</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={0}
                            max={1}
                            step={0.05}
                            value={propertiesForm['player-position-acceptance-threshold']}
                            onChange={(e) =>
                              setProp(
                                'player-position-acceptance-threshold',
                                parseFloat(e.target.value) || 0.5,
                              )
                            }
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Attack Direction Threshold</span>
                          <span className="prop-hint">How closely aim must match attack direction (0–1)</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={0}
                            max={1}
                            step={0.05}
                            value={propertiesForm['player-movement-action-direction-threshold']}
                            onChange={(e) =>
                              setProp(
                                'player-movement-action-direction-threshold',
                                parseFloat(e.target.value) || 0.85,
                              )
                            }
                          />
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Block Breaking Range Scalar</span>
                          <span className="prop-hint">Scale factor for server-side break range check</span>
                          <input
                            className="prop-input narrow"
                            type="number"
                            min={0.5}
                            max={5}
                            step={0.1}
                            value={propertiesForm['server-authoritative-block-breaking-pick-range-scalar']}
                            onChange={(e) =>
                              setProp(
                                'server-authoritative-block-breaking-pick-range-scalar',
                                parseFloat(e.target.value) || 1.5,
                              )
                            }
                          />
                        </label>
                      </div>
                    </section>

                    {/* ── Logging ── */}
                    <section className="props-section">
                      <h4 className="props-section-title">Content Logging</h4>
                      <div className="props-grid">
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Log to File</span>
                          <span className="prop-hint">Write content errors to a log file</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['content-log-file-enabled'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'content-log-file-enabled',
                                !propertiesForm['content-log-file-enabled'],
                              )
                            }
                            aria-pressed={propertiesForm['content-log-file-enabled']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row prop-toggle-row">
                          <span className="prop-label">Log to Console</span>
                          <span className="prop-hint">Print content errors to stdout</span>
                          <button
                            type="button"
                            className={`prop-toggle${propertiesForm['content-log-console-output-enabled'] ? ' on' : ''}`}
                            onClick={() =>
                              setProp(
                                'content-log-console-output-enabled',
                                !propertiesForm['content-log-console-output-enabled'],
                              )
                            }
                            aria-pressed={propertiesForm['content-log-console-output-enabled']}
                          >
                            <span className="prop-toggle-thumb" />
                          </button>
                        </label>
                        <label className="prop-row">
                          <span className="prop-label">Log Level</span>
                          <select
                            className="prop-select"
                            value={propertiesForm['content-log-level']}
                            onChange={(e) =>
                              setProp(
                                'content-log-level',
                                e.target.value as BedrockServerProperties['content-log-level'],
                              )
                            }
                          >
                            <option value="error">Error (highest priority only)</option>
                            <option value="warning">Warning</option>
                            <option value="info">Info</option>
                            <option value="verbose">Verbose (all)</option>
                          </select>
                        </label>
                      </div>
                    </section>

                    <div className="props-footer">
                      <button
                        type="button"
                        className="props-reload-btn"
                        onClick={reloadProperties}
                        disabled={propertiesSaving}
                      >
                        Discard &amp; Reload
                      </button>
                      <div className="props-footer-right">
                        {propertiesDirty ? (
                          <span className="props-dirty-badge">Unsaved changes</span>
                        ) : null}
                        <button
                          type="button"
                          className="props-save-btn"
                          onClick={() => void saveProperties()}
                          disabled={propertiesSaving || !propertiesDirty}
                        >
                          {propertiesSaving ? 'Saving...' : 'Save Properties'}
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {settingsTab === 'general' ? (
              <div className="settings-panel" role="tabpanel" aria-label="General settings">
                <section className="props-section general-section">
                  <h4 className="props-section-title">Installer Status</h4>
                  <div className="general-status-grid">
                    <article className="settings-card general-status-card">
                      <h4>Installation</h4>
                      <div className="general-status-row">
                        <span
                          className={`status-pill ${
                            installerStatus.installed ? 'ok' : 'warn'
                          }`}
                        >
                          {installerStatus.installed ? 'Installed' : 'Not Installed'}
                        </span>
                        {installerStatus.isInstalling ? (
                          <span className="status-pill info">Installing…</span>
                        ) : null}
                      </div>
                      <p>
                        <strong>Version:</strong> {installerStatus.installedVersion ?? 'n/a'}
                      </p>
                      <p>
                        <strong>Last Install:</strong>{' '}
                        {installerStatus.lastInstallAt
                          ? new Date(installerStatus.lastInstallAt).toLocaleString()
                          : 'never'}
                      </p>
                    </article>

                    <article className="settings-card general-status-card">
                      <h4>Server Runtime</h4>
                      <p>
                        <strong>Executable:</strong>{' '}
                        {installerStatus.executablePath || 'Not detected yet'}
                      </p>
                      <p>
                        <strong>Source:</strong>{' '}
                        {installerStatus.lastResolvedDownloadUrl ??
                          'Auto discovery will resolve latest official package'}
                      </p>
                      <p>
                        <strong>Override URL:</strong>{' '}
                        {installerStatus.downloadUrlConfigured ? 'Configured' : 'Using auto discovery'}
                      </p>
                    </article>
                  </div>
                </section>

                <section className="props-section general-section">
                  <h4 className="props-section-title">Install or Update</h4>
                  <p className="general-install-hint">
                    Use an official direct package URL if you need to pin a specific build; leave blank to
                    auto-discover latest.
                  </p>
                  <div className="settings-install-tools general-install-tools">
                    <input
                      type="url"
                      className="download-url"
                      value={downloadUrl}
                      onChange={(event) => setDownloadUrl(event.target.value)}
                      placeholder="Optional manual URL override"
                    />
                    <button
                      type="button"
                      onClick={() => void runInstall()}
                      disabled={busy || installerStatus.isInstalling}
                    >
                      {installerStatus.isInstalling ? 'Installing...' : 'Install or Update Server'}
                    </button>
                </div>
                </section>
              </div>
            ) : null}
          </section>
        ) : null}

        {selectedPage === 'server-files' ? (
          <section className="server-settings-wrap">
            <h3>Server Files</h3>
            <div className="files-header-row">
              <div className="settings-tabs" role="tablist" aria-label="Server files tabs">
                <button
                  className={filesTab === 'mods-browser' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => setFilesTab('mods-browser')}
                  type="button"
                >
                  🌐 Mods Browser
                </button>
                <button
                  className={filesTab === 'downloads' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => {
                    setFilesTab('downloads');
                    void loadDownloads();
                  }}
                  type="button"
                >
                  📥 Downloads
                </button>
                <button
                  className={filesTab === 'resource-packs' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => setFilesTab('resource-packs')}
                  type="button"
                >
                  Resource Packs
                </button>
                <button
                  className={filesTab === 'behavior-packs' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => setFilesTab('behavior-packs')}
                  type="button"
                >
                  Behavior Packs
                </button>
                <button
                  className={filesTab === 'worlds' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => {
                    setFilesTab('worlds');
                    void loadFileDirectory('worlds');
                  }}
                  type="button"
                >
                  Worlds
                </button>
                <button
                  className={filesTab === 'file-manager' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => {
                    setFilesTab('file-manager');
                    if (filePath !== '.') {
                      void loadFileDirectory('.');
                    }
                  }}
                  type="button"
                >
                  File Manager
                </button>
              </div>

              <div className="files-header-right">
                {isFileManagerTab ? (
                  <div className="file-toolbar-actions">
                    <button
                      type="button"
                      className="settings-tab icon-tab"
                      onClick={() => void loadFileDirectory(filePath)}
                      title="Refresh"
                      aria-label="Refresh"
                    >
                      ↻
                    </button>
                    <button
                      type="button"
                      className="settings-tab icon-tab"
                      onClick={() => void handleCreateFolder()}
                      title="New Folder"
                      aria-label="New Folder"
                    >
                      📁+
                    </button>
                    <label
                      className={`packs-header-upload icon-tab${fileDragOver ? ' drag-over' : ''}${fileUploading ? ' uploading' : ''}`}
                      title={fileUploading ? 'Uploading...' : 'Upload File'}
                      aria-label={fileUploading ? 'Uploading...' : 'Upload File'}
                      onDragOver={(e) => {
                        if (fileUploading) {
                          return;
                        }
                        e.preventDefault();
                        setFileDragOver(true);
                      }}
                      onDragLeave={() => setFileDragOver(false)}
                      onDrop={(e) => {
                        if (fileUploading) {
                          return;
                        }
                        e.preventDefault();
                        setFileDragOver(false);
                        void handleFileUpload(e.dataTransfer.files, filePath);
                      }}
                    >
                      <span>{fileUploading ? '…' : '↑'}</span>
                      <input
                        type="file"
                        className="packs-upload-input"
                        disabled={fileUploading}
                        onChange={(e) => {
                          void handleFileUpload(e.target.files, filePath);
                          e.currentTarget.value = '';
                        }}
                      />
                    </label>
                  </div>
                ) : isWorldsTab ? (
                  <div className="file-toolbar-actions">
                    <button
                      type="button"
                      className="settings-tab icon-tab"
                      onClick={() => void loadFileDirectory('worlds')}
                      title="Refresh"
                      aria-label="Refresh"
                    >
                      ↻
                    </button>
                    <label
                      className={`packs-header-upload icon-tab${fileDragOver ? ' drag-over' : ''}${fileUploading ? ' uploading' : ''}`}
                      title={fileUploading ? 'Uploading...' : 'Upload World File'}
                      aria-label={fileUploading ? 'Uploading...' : 'Upload World File'}
                      onDragOver={(e) => {
                        if (fileUploading) {
                          return;
                        }
                        e.preventDefault();
                        setFileDragOver(true);
                      }}
                      onDragLeave={() => setFileDragOver(false)}
                      onDrop={(e) => {
                        if (fileUploading) {
                          return;
                        }
                        e.preventDefault();
                        setFileDragOver(false);
                        void handleFileUpload(e.dataTransfer.files, 'worlds');
                      }}
                    >
                      <span>{fileUploading ? '…' : '↑'}</span>
                      <input
                        type="file"
                        className="packs-upload-input"
                        disabled={fileUploading}
                        onChange={(e) => {
                          void handleFileUpload(e.target.files, 'worlds');
                          e.currentTarget.value = '';
                        }}
                      />
                    </label>
                  </div>
                ) : isModsBrowserTab ? (
                  <div className="file-toolbar-actions">
                    <button
                      type="button"
                      className="settings-tab icon-tab"
                      title="Back"
                      aria-label="Back"
                      onClick={() => {
                        modsWebviewRef.current?.contentWindow?.history.back();
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="settings-tab icon-tab"
                      title="Forward"
                      aria-label="Forward"
                      onClick={() => {
                        modsWebviewRef.current?.contentWindow?.history.forward();
                      }}
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className="settings-tab icon-tab"
                      title="Refresh browser"
                      aria-label="Refresh browser"
                      onClick={() => {
                        modsWebviewRef.current?.contentWindow?.location.reload();
                      }}
                    >
                      ↻
                    </button>
                    <span className="mods-lock-badge" title="Browsing is locked to CurseForge Bedrock">🔒 CurseForge</span>
                  </div>
                ) : isDownloadsTab ? (
                  <div className="file-toolbar-actions">
                    <button
                      type="button"
                      className="settings-tab icon-tab"
                      title="Refresh downloads"
                      aria-label="Refresh downloads"
                      onClick={() => void loadDownloads()}
                    >
                      ↻
                    </button>
                  </div>
                ) : (
                  <label
                    className={`packs-header-upload${packsDragOver ? ' drag-over' : ''}${packsUploading ? ' uploading' : ''}`}
                    onDragOver={(e) => {
                      if (packsUploading) {
                        return;
                      }
                      e.preventDefault();
                      setPacksDragOver(true);
                    }}
                    onDragLeave={() => setPacksDragOver(false)}
                    onDrop={(e) => {
                      if (packsUploading) {
                        return;
                      }
                      e.preventDefault();
                      setPacksDragOver(false);
                      void handlePackUpload(e.dataTransfer.files);
                    }}
                  >
                    <span>{packsUploading ? 'Uploading pack...' : '📦 Install Pack'}</span>
                    <input
                      type="file"
                      accept=".mcpack,.mcaddon"
                      multiple
                      className="packs-upload-input"
                      disabled={packsUploading}
                      onChange={(e) => void handlePackUpload(e.target.files)}
                    />
                  </label>
                )}

                <div className="files-header-notices" role="status" aria-live="polite">
                  {isFileManagerTab || isWorldsTab ? (
                    <>
                      {fileUploading ? <span className="header-notice loading">Uploading file...</span> : null}
                    </>
                  ) : isModsBrowserTab || isDownloadsTab ? (
                    <></>
                  ) : (
                    <>
                      {packsUploading ? <span className="header-notice loading">Uploading pack...</span> : null}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div
              className={isModsBrowserTab ? 'mods-browser-standalone' : 'settings-panel packs-panel'}
              role="tabpanel"
            >
              {isFileManagerTab ? (
                <>
                  <div className="file-path-row">
                    <span className="file-path-label">Path:</span>
                    <button type="button" className="file-path-button" onClick={() => void loadFileDirectory('.')}>
                      /
                    </button>
                    {fileParentPath ? (
                      <button type="button" className="file-path-button" onClick={() => void loadFileDirectory(fileParentPath)}>
                        ..
                      </button>
                    ) : null}
                    <span className="file-path-value">{filePath === '.' ? '/' : filePath}</span>
                  </div>

                  <div className="file-search-row">
                    <input
                      type="search"
                      className="file-search-input"
                      placeholder="Search files and folders"
                      value={fileSearch}
                      onChange={(event) => setFileSearch(event.target.value)}
                    />
                  </div>

                  {fileLoading ? (
                    <p className="packs-loading">Loading files...</p>
                  ) : fileEntries.length === 0 ? (
                    <p className="packs-empty">This folder is empty.</p>
                  ) : (
                    <div className="file-table-wrap">
                      <table className="file-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Size</th>
                            <th>Modified</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fileEntries
                            .filter((entry) => entry.name.toLowerCase().includes(fileSearch.trim().toLowerCase()))
                            .map((entry) => {
                              const busy = fileBusyPaths.has(entry.relativePath);
                              return (
                                <tr key={entry.relativePath}>
                                  <td>
                                    {entry.kind === 'directory' ? (
                                      <button
                                        type="button"
                                        className="file-link"
                                        disabled={busy}
                                        onClick={() => void loadFileDirectory(entry.relativePath)}
                                      >
                                        📁 {entry.name}
                                      </button>
                                    ) : (
                                      <span>📄 {entry.name}</span>
                                    )}
                                  </td>
                                  <td>{entry.kind === 'directory' ? 'Folder' : 'File'}</td>
                                  <td>{entry.sizeBytes == null ? '-' : `${Math.max(1, Math.round(entry.sizeBytes / 1024))} KB`}</td>
                                  <td>{new Date(entry.modifiedAt).toLocaleString()}</td>
                                  <td>
                                    <div className="file-actions">
                                      {entry.kind === 'directory' ? (
                                        <a
                                          className="file-action-btn"
                                          href={serverFolderZipUrl(entry.relativePath)}
                                          download
                                        >
                                          Download Zip
                                        </a>
                                      ) : (
                                        <a
                                          className="file-action-btn"
                                          href={serverFileDownloadUrl(entry.relativePath)}
                                          download
                                        >
                                          Download
                                        </a>
                                      )}
                                      {entry.kind === 'file' && canEditTextFile(entry.name) ? (
                                        <button
                                          type="button"
                                          className="file-action-btn"
                                          disabled={busy}
                                          onClick={() => void openTextEditor(entry)}
                                        >
                                          Edit
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="file-action-btn"
                                        disabled={busy}
                                        onClick={() => void handleRenameItem(entry)}
                                      >
                                        Rename
                                      </button>
                                      <button
                                        type="button"
                                        className="file-action-btn danger"
                                        disabled={busy}
                                        onClick={() => void handleDeleteItem(entry)}
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {editingFilePath ? (
                    <div className="file-editor">
                      <div className="file-editor-header">
                        <h4>{editingFilePath}</h4>
                        <div className="file-editor-actions">
                          <button
                            type="button"
                            className="file-action-btn"
                            onClick={() => {
                              setEditingFilePath('');
                              setEditingFileContent('');
                              setEditingFileDirty(false);
                            }}
                            disabled={editingFileBusy}
                          >
                            Close
                          </button>
                          <button
                            type="button"
                            className="file-action-btn"
                            onClick={() => void saveTextEditor()}
                            disabled={editingFileBusy || !editingFileDirty}
                          >
                            {editingFileBusy ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                      <textarea
                        className="file-editor-text"
                        value={editingFileContent}
                        onChange={(event) => {
                          setEditingFileContent(event.target.value);
                          setEditingFileDirty(true);
                        }}
                      />
                    </div>
                  ) : null}
                </>
              ) : isModsBrowserTab ? (
                <div className="mods-webview-stage">
                  <iframe
                    ref={modsWebviewRef}
                    src="https://www.curseforge.com/minecraft-bedrock"
                    className="mods-webview"
                    title="Mods Browser"
                  />
                </div>
              ) : isDownloadsTab ? (
                downloadsLoading ? (
                  <p className="packs-loading">Loading downloads…</p>
                ) : downloadEntries.length === 0 ? (
                  <p className="packs-empty">No .mcpack or .mcaddon files found. Browse mods in the Mods Browser tab and click Download.</p>
                ) : (
                  <div className="file-table-wrap">
                    <table className="file-table downloads-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Type</th>
                          <th>Size</th>
                          <th>Modified</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {downloadEntries.map((entry) => {
                          const busy = downloadsBusy.has(entry.filename);
                          const installed = isDownloadFullyInstalled(entry, packsBehavior, packsResource);
                          const installedPacks = getInstalledPacksForDownload(
                            entry,
                            packsBehavior,
                            packsResource,
                          );
                          const knownPacks = entry.packs?.length ?? 0;
                          const statusLabel = installed
                            ? 'Installed'
                            : installedPacks.length > 0
                              ? 'Partially installed'
                              : 'Not installed';

                          return (
                            <tr key={entry.filename}>
                              <td title={entry.filename}>{getDownloadDisplayName(entry)}</td>
                              <td>{entry.filename.toLowerCase().endsWith('.mcaddon') ? 'Addon' : 'Pack'}</td>
                              <td>{`${Math.max(1, Math.round(entry.sizeBytes / 1024))} KB`}</td>
                              <td>{new Date(entry.modifiedAt).toLocaleString()}</td>
                              <td>
                                <span className={`download-status ${installed ? 'ok' : installedPacks.length > 0 ? 'warn' : 'off'}`}>
                                  {statusLabel}
                                  {knownPacks > 0 ? ` (${installedPacks.length}/${knownPacks})` : ''}
                                </span>
                              </td>
                              <td>
                                <div className="file-actions">
                                  <button
                                    className={`file-action-btn${installed ? ' danger' : ''}`}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void (installed ? handleUninstallDownload(entry) : handleInstallDownload(entry))}
                                  >
                                    {busy ? (installed ? 'Removing…' : 'Installing…') : installed ? 'Uninstall' : 'Install'}
                                  </button>
                                  <a
                                    className="file-action-btn"
                                    href={serverFileDownloadUrl(`downloads/${entry.filename}`)}
                                    download
                                  >
                                    Download
                                  </a>
                                  <button
                                    className="file-action-btn danger"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleDeleteDownload(entry)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              ) : isWorldsTab ? fileLoading ? (
                <p className="packs-loading">Loading worlds…</p>
              ) : fileEntries.filter((entry) => entry.kind === 'directory').length === 0 ? (
                <p className="packs-empty">No worlds found in the worlds folder.</p>
              ) : (
                <div className="pack-grid world-grid">
                  {fileEntries
                    .filter((entry) => entry.kind === 'directory')
                    .map((entry) => {
                      const busy = fileBusyPaths.has(entry.relativePath);
                      const isActive =
                        normalizedActiveWorld.length > 0 &&
                        entry.name.toLowerCase() === normalizedActiveWorld;

                      return (
                        <div
                          key={entry.relativePath}
                          className={`pack-tile world-tile card-art-tile${isActive ? ' active' : ''}`}
                          style={{
                            backgroundImage: `linear-gradient(180deg, rgba(9, 12, 18, 0.12) 0%, rgba(9, 12, 18, 0.48) 58%, rgba(9, 12, 18, 0.78) 100%), url(${worldIconUrl(entry.relativePath)})`,
                          }}
                        >
                          <button
                            className="pack-tile-delete"
                            disabled={busy}
                            onClick={() => void handleDeleteItem(entry)}
                            aria-label={`Delete ${entry.name}`}
                            type="button"
                          >
                            🗑
                          </button>
                          <div className="world-tile-body">
                            <div className="pack-tile-name">{entry.name}</div>
                            <div className="pack-tile-meta">
                              Updated {new Date(entry.modifiedAt).toLocaleString()}
                            </div>
                          </div>
                          <div className="pack-tile-footer">
                            <button
                              className={`pack-toggle-btn world-state-btn${isActive ? ' active' : ''}`}
                              type="button"
                              disabled
                            >
                              {activeWorldLoading ? 'Checking...' : isActive ? 'Active World' : 'Inactive'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : packsLoading ? (
                <p className="packs-loading">Loading packs…</p>
              ) : (filesTab === 'behavior-packs' ? packsBehavior : packsResource).length === 0 ? (
                <p className="packs-empty">
                  No {filesTab === 'behavior-packs' ? 'behavior' : 'resource'} packs installed.
                </p>
              ) : (
                <div className="pack-grid">
                  {(filesTab === 'behavior-packs' ? packsBehavior : packsResource).map((pack) => {
                    const busy = packsBusy.has(pack.uuid);
                    return (
                      <div
                        key={pack.uuid}
                        className="pack-tile card-art-tile"
                        style={{
                          backgroundImage: `linear-gradient(180deg, rgba(9, 12, 18, 0.08) 0%, rgba(9, 12, 18, 0.42) 48%, rgba(9, 12, 18, 0.72) 100%), url(${packIconUrl(filesTab === 'behavior-packs' ? 'behavior' : 'resource', pack.uuid)})`,
                        }}
                      >
                        <button
                          className="pack-tile-delete"
                          type="button"
                          disabled={busy}
                          aria-label={`Delete ${pack.name}`}
                          onClick={() => void handlePackDelete(pack)}
                        >
                          🗑
                        </button>
                        <div className={`pack-tile-name${getTileTitleClass(pack.name)}`} title={pack.name}>{pack.name}</div>
                        <div className="pack-tile-footer">
                          <button
                            className={`pack-toggle-btn${pack.active ? ' active' : ''}`}
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePackToggle(pack)}
                          >
                            {busy ? 'Working…' : pack.active ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

            </div>

            {!isFileManagerTab && !isWorldsTab && !isModsBrowserTab && !isDownloadsTab ? (
              <p className="packs-restart-note">⚠ Pack changes require a server restart to take effect.</p>
            ) : null}
          </section>
        ) : null}

        {dialogState ? (
          <div className="app-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
            <div className="app-dialog">
              <h3 id="dialog-title" className="app-dialog-title">{dialogState.title}</h3>
              {dialogState.message ? <p className="app-dialog-message">{dialogState.message}</p> : null}
              {dialogState.mode === 'input' ? (
                <input
                  type="text"
                  value={dialogState.value}
                  autoFocus
                  onChange={(event) => {
                    setDialogState((current) =>
                      current && current.mode === 'input'
                        ? {
                            ...current,
                            value: event.target.value,
                          }
                        : current,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      closeDialog(null);
                      return;
                    }
                    if (event.key === 'Enter' && dialogState.value.trim()) {
                      closeDialog(dialogState.value);
                    }
                  }}
                />
              ) : null}
              <div className="app-dialog-actions">
                <button type="button" className="app-dialog-btn" onClick={() => closeDialog(null)}>
                  {dialogState.cancelLabel}
                </button>
                <button
                  type="button"
                  className="app-dialog-btn primary"
                  disabled={dialogState.mode === 'input' && !dialogState.value.trim()}
                  onClick={() =>
                    closeDialog(dialogState.mode === 'input' ? dialogState.value : true)
                  }
                >
                  {dialogState.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {toastState ? (
          <div className="app-toast-stack" aria-live="polite" aria-atomic="true">
            <div className={`app-toast ${toastState.tone}`} role="status">
              {toastState.message}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App;