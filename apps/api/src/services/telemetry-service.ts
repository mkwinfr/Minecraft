import { readdir, stat } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import pidusage from 'pidusage';
import type {
  ServerLifecycleState,
  ServerTelemetryResponse,
  TelemetryAlert,
  TelemetryEvent,
} from '@bedrock-panel/shared';
import { getServerStatus, subscribeServerLifecycle, subscribeServerLogs } from './process-manager';
import { getBedrockInstallerStatus } from './bedrock-installer';

interface TelemetryConfig {
  bedrockServerDir: string;
}

interface InternalSample {
  atMs: number;
  state: ServerLifecycleState;
  cpuPercent: number | null;
  memoryMb: number | null;
  playersOnline: number;
  diskFreeGb: number | null;
  worldSizeMb: number | null;
}

const sampleIntervalMs = 5000;
const diskSampleIntervalMs = 30000;
const worldSizeSampleIntervalMs = 60000;
const rawRetentionMs = 24 * 60 * 60 * 1000;
const rollupRetentionDays = 90;

let config: TelemetryConfig | null = null;
let started = false;
let sampleTimer: NodeJS.Timeout | null = null;
let diskTimer: NodeJS.Timeout | null = null;
let worldSizeTimer: NodeJS.Timeout | null = null;
let unsubLifecycle: (() => void) | null = null;
let unsubLogs: (() => void) | null = null;

const rawSamples: InternalSample[] = [];
const events: TelemetryEvent[] = [];
const alerts = new Map<string, TelemetryAlert>();

let playersOnline = 0;
let peakPlayersToday = 0;
let memoryPeakMb = 0;
let connectFailuresToday = 0;

let lastDiskFreeGb: number | null = null;
let lastWorldSizeMb: number | null = null;

let pendingStartAtMs: number | null = null;
const startupDurationsMs: number[] = [];
const actionLatenciesMs: number[] = [];
const apiLatenciesMs: number[] = [];

let dailyKey = getDayKey(Date.now());
const dailyCounts = {
  starts: 0,
  stops: 0,
  restarts: 0,
  crashes: 0,
  joins: 0,
  leaves: 0,
  backupFailures: 0,
};

function getDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function rotateDailyCounters(nowMs: number) {
  const key = getDayKey(nowMs);
  if (dailyKey === key) {
    return;
  }

  dailyKey = key;
  dailyCounts.starts = 0;
  dailyCounts.stops = 0;
  dailyCounts.restarts = 0;
  dailyCounts.crashes = 0;
  dailyCounts.joins = 0;
  dailyCounts.leaves = 0;
  dailyCounts.backupFailures = 0;
  peakPlayersToday = playersOnline;
  connectFailuresToday = 0;
}

function pushBounded<T>(target: T[], value: T, limit: number) {
  target.push(value);
  if (target.length > limit) {
    target.splice(0, target.length - limit);
  }
}

function addEvent(
  category: TelemetryEvent['category'],
  severity: TelemetryEvent['severity'],
  message: string,
  atMs = Date.now(),
) {
  pushBounded(
    events,
    {
      at: new Date(atMs).toISOString(),
      category,
      severity,
      message,
    },
    400,
  );
}

function setAlert(id: string, severity: TelemetryAlert['severity'], message: string) {
  const now = new Date().toISOString();
  const current = alerts.get(id);
  if (!current) {
    alerts.set(id, {
      id,
      severity,
      message,
      active: true,
      startedAt: now,
      lastTriggeredAt: now,
    });
    addEvent('alert', severity, message);
    return;
  }

  current.active = true;
  current.severity = severity;
  current.message = message;
  current.lastTriggeredAt = now;
}

function clearAlert(id: string) {
  const current = alerts.get(id);
  if (!current || !current.active) {
    return;
  }

  current.active = false;
}

function pruneRawSamples(nowMs: number) {
  const minTime = nowMs - rawRetentionMs;
  while (rawSamples.length > 0 && (rawSamples[0]?.atMs ?? Number.POSITIVE_INFINITY) < minTime) {
    rawSamples.shift();
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index] ?? null;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getUptimePercent24h(nowMs: number): number {
  const minTime = nowMs - rawRetentionMs;
  const relevant = rawSamples.filter((sample) => sample.atMs >= minTime);
  if (relevant.length === 0) {
    return 0;
  }

  const runningCount = relevant.filter((sample) => sample.state === 'running').length;
  return (runningCount / relevant.length) * 100;
}

function getLatestTrend60m(nowMs: number): ServerTelemetryResponse['trends']['last60m'] {
  const minTime = nowMs - 60 * 60 * 1000;
  const bucketMap = new Map<number, InternalSample[]>();

  for (const sample of rawSamples) {
    if (sample.atMs < minTime) {
      continue;
    }

    const minuteKey = Math.floor(sample.atMs / 60000) * 60000;
    const bucket = bucketMap.get(minuteKey);
    if (bucket) {
      bucket.push(sample);
    } else {
      bucketMap.set(minuteKey, [sample]);
    }
  }

  const points = [...bucketMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minuteMs, bucket]) => {
      const cpuValues = bucket.map((item) => item.cpuPercent).filter((item): item is number => item !== null);
      const memValues = bucket.map((item) => item.memoryMb).filter((item): item is number => item !== null);
      const playerValues = bucket.map((item) => item.playersOnline);

      return {
        at: new Date(minuteMs).toISOString(),
        cpuPercent: average(cpuValues),
        memoryMb: average(memValues),
        playersOnline: Math.round(average(playerValues) ?? 0),
      };
    });

  return points.slice(-60);
}

async function getDirectorySizeBytes(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;

    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySizeBytes(full);
      } else if (entry.isFile()) {
        const info = await stat(full);
        total += info.size;
      }
    }

    return total;
  } catch {
    return 0;
  }
}

async function refreshWorldSize() {
  if (!config) {
    return;
  }

  const worldsDir = join(config.bedrockServerDir, 'worlds');
  const bytes = await getDirectorySizeBytes(worldsDir);
  lastWorldSizeMb = bytes / (1024 * 1024);
}

function refreshDiskSpace() {
  if (!config) {
    return;
  }

  try {
    const stats = statfsSync(config.bedrockServerDir);
    const freeBytes = stats.bavail * stats.bsize;
    lastDiskFreeGb = freeBytes / (1024 * 1024 * 1024);
  } catch {
    lastDiskFreeGb = null;
  }
}

async function collectSample() {
  const nowMs = Date.now();
  rotateDailyCounters(nowMs);

  const status = getServerStatus();
  let cpuPercent: number | null = null;
  let memoryMb: number | null = null;

  if (status.pid) {
    try {
      const usage = await pidusage(status.pid);
      cpuPercent = usage.cpu;
      memoryMb = usage.memory / (1024 * 1024);
      if (memoryMb > memoryPeakMb) {
        memoryPeakMb = memoryMb;
      }
    } catch {
      cpuPercent = null;
      memoryMb = null;
    }
  }

  const sample: InternalSample = {
    atMs: nowMs,
    state: status.state,
    cpuPercent,
    memoryMb,
    playersOnline,
    diskFreeGb: lastDiskFreeGb,
    worldSizeMb: lastWorldSizeMb,
  };

  rawSamples.push(sample);
  pruneRawSamples(nowMs);

  if ((memoryMb ?? 0) > 1500) {
    setAlert('high-memory', 'warn', `High memory usage detected: ${Math.round(memoryMb ?? 0)} MB`);
  } else {
    clearAlert('high-memory');
  }

  if ((lastDiskFreeGb ?? 999) < 5) {
    setAlert('low-disk', 'error', `Low disk space: ${(lastDiskFreeGb ?? 0).toFixed(2)} GB free`);
  } else {
    clearAlert('low-disk');
  }
}

function parsePlayerTelemetry(logLine: string) {
  const lower = logLine.toLowerCase();
  const now = Date.now();

  if (/disconnected|left/.test(lower) && /player|xuid/.test(lower)) {
    playersOnline = Math.max(0, playersOnline - 1);
    dailyCounts.leaves += 1;
    addEvent('player', 'info', `Player left. Online now: ${playersOnline}`, now);
  } else if (/joined|\bconnected\b/.test(lower) && /player|xuid/.test(lower)) {
    playersOnline = Math.max(0, playersOnline + 1);
    dailyCounts.joins += 1;
    peakPlayersToday = Math.max(peakPlayersToday, playersOnline);
    addEvent('player', 'info', `Player joined. Online now: ${playersOnline}`, now);
  }

  if (/failed to connect|connection.+timed out|connection refused/.test(lower)) {
    connectFailuresToday += 1;
  }

  if (/backup.+failed|failed.+backup/.test(lower)) {
    dailyCounts.backupFailures += 1;
    addEvent('system', 'warn', 'Backup failure detected from logs.', now);
  }
}

function handleLifecycle(state: ServerLifecycleState, reason: string) {
  if (state === 'crashed') {
    dailyCounts.crashes += 1;
    addEvent('crash', 'error', `Server crashed: ${reason}`);

    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const recentCrashes = events.filter(
      (item) => item.category === 'crash' && new Date(item.at).getTime() >= tenMinutesAgo,
    ).length;
    if (recentCrashes >= 3) {
      setAlert('crash-loop', 'error', 'Crash loop detected: 3+ crashes within 10 minutes.');
    }
  }

  if (state === 'running' && pendingStartAtMs) {
    const startupDuration = Date.now() - pendingStartAtMs;
    pushBounded(startupDurationsMs, startupDuration, 100);
    pendingStartAtMs = null;
  }

  addEvent('state', state === 'crashed' ? 'error' : 'info', `State changed to ${state}: ${reason}`);
}

export function configureTelemetryService(nextConfig: TelemetryConfig) {
  config = nextConfig;
}

export function startTelemetryService() {
  if (started) {
    return;
  }

  started = true;
  refreshDiskSpace();
  void refreshWorldSize();
  void collectSample();

  sampleTimer = setInterval(() => {
    void collectSample();
  }, sampleIntervalMs);

  diskTimer = setInterval(() => {
    refreshDiskSpace();
  }, diskSampleIntervalMs);

  worldSizeTimer = setInterval(() => {
    void refreshWorldSize();
  }, worldSizeSampleIntervalMs);

  unsubLogs = subscribeServerLogs((line) => {
    parsePlayerTelemetry(line);
  });

  unsubLifecycle = subscribeServerLifecycle((event) => {
    handleLifecycle(event.state, event.reason);
  });
}

export function stopTelemetryService() {
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  if (diskTimer) {
    clearInterval(diskTimer);
    diskTimer = null;
  }
  if (worldSizeTimer) {
    clearInterval(worldSizeTimer);
    worldSizeTimer = null;
  }
  if (unsubLogs) {
    unsubLogs();
    unsubLogs = null;
  }
  if (unsubLifecycle) {
    unsubLifecycle();
    unsubLifecycle = null;
  }
  started = false;
}

export function recordServerActionTelemetry(
  action: 'start' | 'stop' | 'restart',
  latencyMs: number,
  successful: boolean,
) {
  rotateDailyCounters(Date.now());
  pushBounded(actionLatenciesMs, latencyMs, 500);

  if (action === 'start') {
    dailyCounts.starts += 1;
    pendingStartAtMs = Date.now();
  }
  if (action === 'stop') {
    dailyCounts.stops += 1;
  }
  if (action === 'restart') {
    dailyCounts.restarts += 1;
    pendingStartAtMs = Date.now();
  }

  addEvent(
    'action',
    successful ? 'info' : 'error',
    `Action ${action} ${successful ? 'completed' : 'failed'} in ${Math.round(latencyMs)} ms`,
  );
}

export function recordApiRequestTelemetry(path: string, latencyMs: number, statusCode: number) {
  if (path.includes('/api/server/logs')) {
    return;
  }

  pushBounded(apiLatenciesMs, latencyMs, 1000);

  if (statusCode >= 500) {
    addEvent('system', 'error', `API ${path} responded ${statusCode} in ${Math.round(latencyMs)} ms`);
  }
}

export function recordInstallerTelemetry(successful: boolean, message: string) {
  const severity: TelemetryEvent['severity'] = successful ? 'info' : 'error';
  addEvent('installer', severity, message);
}

function getBackupTelemetry(): ServerTelemetryResponse['backup'] {
  if (!config) {
    return {
      lastBackupAt: null,
      lastBackupDurationMs: null,
      failuresToday: dailyCounts.backupFailures,
      status: 'unknown',
    };
  }

  return {
    lastBackupAt: null,
    lastBackupDurationMs: null,
    failuresToday: dailyCounts.backupFailures,
    status: dailyCounts.backupFailures > 0 ? 'degraded' : 'unknown',
  };
}

export function getServerTelemetry(): ServerTelemetryResponse {
  const nowMs = Date.now();
  rotateDailyCounters(nowMs);

  const status = getServerStatus();
  const latestSample = rawSamples[rawSamples.length - 1];
  const installerStatus = getBedrockInstallerStatus();

  const activeAlerts = [...alerts.values()].filter((alert) => alert.active);
  const latestEvents = [...events].slice(-50).reverse();

  return {
    generatedAt: new Date(nowMs).toISOString(),
    current: {
      state: status.state,
      cpuPercent: latestSample?.cpuPercent ?? null,
      memoryMb: latestSample?.memoryMb ?? null,
      memoryPeakMb: memoryPeakMb > 0 ? memoryPeakMb : null,
      playersOnline,
      diskFreeGb: latestSample?.diskFreeGb ?? null,
      worldSizeMb: latestSample?.worldSizeMb ?? null,
    },
    kpis: {
      uptimePercent24h: getUptimePercent24h(nowMs),
      crashesToday: dailyCounts.crashes,
      restartsToday: dailyCounts.restarts,
      startsToday: dailyCounts.starts,
      stopsToday: dailyCounts.stops,
      joinsToday: dailyCounts.joins,
      leavesToday: dailyCounts.leaves,
      peakPlayersToday,
      startupTimeMsLast: startupDurationsMs[startupDurationsMs.length - 1] ?? null,
      startupTimeMsAvg: average(startupDurationsMs),
      actionLatencyMsAvg: average(actionLatenciesMs),
      actionLatencyMsP95: percentile(actionLatenciesMs, 0.95),
      apiLatencyMsAvg: average(apiLatenciesMs),
      apiLatencyMsP95: percentile(apiLatenciesMs, 0.95),
      updateAgeDays: installerStatus.installedVersion ? null : null,
    },
    trends: {
      last60m: getLatestTrend60m(nowMs),
    },
    backup: getBackupTelemetry(),
    network: {
      connectFailuresToday,
      averageJoinLatencyMs: null,
    },
    retention: {
      rawSampleSeconds: sampleIntervalMs / 1000,
      rawRetentionHours: rawRetentionMs / (60 * 60 * 1000),
      rollupRetentionDays,
    },
    events: latestEvents,
    alerts: activeAlerts,
  };
}
