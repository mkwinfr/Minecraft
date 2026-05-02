export type PackType = 'behavior' | 'resource';

export interface BedrockPack {
  uuid: string;
  type: PackType;
  name: string;
  description: string;
  version: [number, number, number];
  folderName: string;
  active: boolean;
}

export interface PacksResponse {
  behaviorPacks: BedrockPack[];
  resourcePacks: BedrockPack[];
  worldName: string;
}

export interface PackToggleResponse {
  ok: true;
  active: boolean;
  message: string;
}

export interface PackDeleteResponse {
  ok: true;
  message: string;
}

export interface PackUploadResponse {
  ok: true;
  installed: BedrockPack[];
  message: string;
}

export type ServerFileKind = 'file' | 'directory';

export interface ServerFileEntry {
  name: string;
  relativePath: string;
  kind: ServerFileKind;
  sizeBytes: number | null;
  modifiedAt: string;
}

export interface ServerFilesListResponse {
  currentPath: string;
  parentPath: string | null;
  entries: ServerFileEntry[];
}

export interface ServerFileActionResponse {
  ok: true;
  message: string;
}

export interface ServerFileTextResponse {
  path: string;
  content: string;
}

export type ServerLifecycleState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed';

export interface HealthResponse {
  ok: true;
  service: 'api';
  timestamp: string;
}

export interface ServerStatusResponse {
  state: ServerLifecycleState;
  pid: number | null;
  uptimeMs: number;
  bedrockVersion: string | null;
}

export interface ServerActionResponse {
  action: 'start' | 'stop' | 'restart';
  accepted: true;
  message: string;
  requestedAt: string;
}

export interface InstallerStatusResponse {
  installed: boolean;
  installedVersion: string | null;
  executablePath: string;
  downloadUrlConfigured: boolean;
  isInstalling: boolean;
  lastInstallAt: string | null;
  lastResolvedDownloadUrl: string | null;
}

export interface InstallerActionResponse {
  accepted: true;
  message: string;
  installed: boolean;
  installedVersion: string | null;
}

export interface InstallerDiscoveryResponse {
  url: string;
}

export interface ApiErrorResponse {
  error: string;
  details?: string;
}

export interface BedrockServerProperties {
  // General
  'server-name': string;
  'level-name': string;
  'level-seed': string;
  gamemode: 'survival' | 'creative' | 'adventure';
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard';
  'max-players': number;
  'force-gamemode': boolean;
  // Access & Security
  'online-mode': boolean;
  'allow-cheats': boolean;
  'allow-list': boolean;
  'texturepack-required': boolean;
  'default-player-permission-level': 'visitor' | 'member' | 'operator';
  'chat-restriction': 'None' | 'Dropped' | 'Disabled';
  'disable-custom-skins': boolean;
  'player-idle-timeout': number;
  'disable-player-interaction': boolean;
  // Network
  'server-port': number;
  'server-portv6': number;
  'enable-lan-visibility': boolean;
  'compression-threshold': number;
  'compression-algorithm': 'zlib' | 'snappy';
  // Performance / World
  'view-distance': number;
  'tick-distance': number;
  'max-threads': number;
  'client-side-chunk-generation-enabled': boolean;
  'block-network-ids-are-hashes': boolean;
  // Anti-Cheat / Movement
  'server-authoritative-movement-strict': boolean;
  'server-authoritative-dismount-strict': boolean;
  'server-authoritative-entity-interactions-strict': boolean;
  'player-position-acceptance-threshold': number;
  'player-movement-action-direction-threshold': number;
  'server-authoritative-block-breaking-pick-range-scalar': number;
  // Logging
  'content-log-file-enabled': boolean;
  'content-log-console-output-enabled': boolean;
  'content-log-level': 'error' | 'warning' | 'info' | 'verbose';
}

export interface ServerPropertiesResponse {
  properties: BedrockServerProperties;
  fileExists: boolean;
}

export interface ServerPropertiesUpdateResponse {
  ok: true;
  message: string;
}

export interface LogEvent {
  kind: 'log';
  at: string;
  line: string;
}

export interface TelemetryTrendPoint {
  at: string;
  cpuPercent: number | null;
  memoryMb: number | null;
  playersOnline: number;
}

export interface TelemetryEvent {
  at: string;
  category: 'state' | 'action' | 'crash' | 'player' | 'installer' | 'alert' | 'system';
  severity: 'info' | 'warn' | 'error';
  message: string;
}

export interface TelemetryAlert {
  id: string;
  severity: 'warn' | 'error';
  message: string;
  active: boolean;
  startedAt: string;
  lastTriggeredAt: string;
}

export interface ServerTelemetryResponse {
  generatedAt: string;
  current: {
    state: ServerLifecycleState;
    cpuPercent: number | null;
    memoryMb: number | null;
    memoryPeakMb: number | null;
    playersOnline: number;
    diskFreeGb: number | null;
    worldSizeMb: number | null;
  };
  kpis: {
    uptimePercent24h: number;
    crashesToday: number;
    restartsToday: number;
    startsToday: number;
    stopsToday: number;
    joinsToday: number;
    leavesToday: number;
    peakPlayersToday: number;
    startupTimeMsLast: number | null;
    startupTimeMsAvg: number | null;
    actionLatencyMsAvg: number | null;
    actionLatencyMsP95: number | null;
    apiLatencyMsAvg: number | null;
    apiLatencyMsP95: number | null;
    updateAgeDays: number | null;
  };
  trends: {
    last60m: TelemetryTrendPoint[];
  };
  backup: {
    lastBackupAt: string | null;
    lastBackupDurationMs: number | null;
    failuresToday: number;
    status: 'unknown' | 'healthy' | 'degraded';
  };
  network: {
    connectFailuresToday: number;
    averageJoinLatencyMs: number | null;
  };
  retention: {
    rawSampleSeconds: number;
    rawRetentionHours: number;
    rollupRetentionDays: number;
  };
  events: TelemetryEvent[];
  alerts: TelemetryAlert[];
}

// ── Downloads ────────────────────────────────────────────────────────────────

export interface DownloadEntry {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
  packs?: DownloadPackPreview[];
}

export interface DownloadPackPreview {
  uuid: string;
  type: PackType;
  name: string;
}

export interface DownloadsListResponse {
  entries: DownloadEntry[];
}

export interface DownloadInstallResponse {
  ok: true;
  installed: BedrockPack[];
  message: string;
}
