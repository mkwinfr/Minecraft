import type {
  BedrockPack,
  BedrockServerProperties,
  DownloadEntry,
  DownloadInstallResponse,
  DownloadsListResponse,
  HealthResponse,
  InstallerActionResponse,
  InstallerStatusResponse,
  LogEvent,
  PackDeleteResponse,
  PacksResponse,
  PackToggleResponse,
  PackType,
  PackUploadResponse,
  ServerActionResponse,
  ServerFileActionResponse,
  ServerFileTextResponse,
  ServerFilesListResponse,
  ServerPropertiesResponse,
  ServerPropertiesUpdateResponse,
  ServerStatusResponse,
  ServerTelemetryResponse,
} from '@bedrock-panel/shared';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() ||
  (import.meta.env.DEV
    ? 'http://127.0.0.1:3001'
    : typeof window !== 'undefined'
      ? window.location.origin
      : 'http://127.0.0.1:3001');

async function parseJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const rawBody = await response.text();

  const parseBodyObject = (): { error?: unknown; message?: unknown } | null => {
    if (!rawBody.trim()) {
      return null;
    }

    try {
      return JSON.parse(rawBody) as { error?: unknown; message?: unknown };
    } catch {
      return null;
    }
  };

  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const payload = parseBodyObject();
      if (payload) {
        const message =
          (typeof payload.error === 'string' && payload.error.trim()) ||
          (typeof payload.message === 'string' && payload.message.trim()) ||
          '';
        if (message) {
          throw new Error(message);
        }
      }
    }

    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  if (!contentType.includes('application/json')) {
    throw new Error('Unexpected server response format. Please refresh and try again.');
  }

  const payload = parseBodyObject();
  if (!payload) {
    throw new Error('The server returned invalid JSON. Please refresh and try again.');
  }

  return payload as T;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return parseJson<HealthResponse>(await fetch(`${API_BASE_URL}/health`));
}

export async function fetchServerStatus(): Promise<ServerStatusResponse> {
  return parseJson<ServerStatusResponse>(
    await fetch(`${API_BASE_URL}/api/server/status`),
  );
}

export async function postServerAction(
  action: 'start' | 'stop' | 'restart',
): Promise<ServerActionResponse> {
  return parseJson<ServerActionResponse>(
    await fetch(`${API_BASE_URL}/api/server/${action}`, { method: 'POST' }),
  );
}

export async function fetchInstallerStatus(): Promise<InstallerStatusResponse> {
  return parseJson<InstallerStatusResponse>(
    await fetch(`${API_BASE_URL}/api/server/installer/status`),
  );
}

export async function postInstallerInstall(
  downloadUrl?: string,
): Promise<InstallerActionResponse> {
  return parseJson<InstallerActionResponse>(
    await fetch(`${API_BASE_URL}/api/server/installer/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadUrl: downloadUrl?.trim() || undefined }),
    }),
  );
}

export async function fetchServerTelemetry(): Promise<ServerTelemetryResponse> {
  return parseJson<ServerTelemetryResponse>(
    await fetch(`${API_BASE_URL}/api/server/telemetry`),
  );
}

export async function fetchServerProperties(): Promise<ServerPropertiesResponse> {
  return parseJson<ServerPropertiesResponse>(
    await fetch(`${API_BASE_URL}/api/server/properties`),
  );
}

export async function updateServerProperties(
  properties: BedrockServerProperties,
): Promise<ServerPropertiesUpdateResponse> {
  return parseJson<ServerPropertiesUpdateResponse>(
    await fetch(`${API_BASE_URL}/api/server/properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
    }),
  );
}

export async function fetchPacks(): Promise<PacksResponse> {
  return parseJson<PacksResponse>(await fetch(`${API_BASE_URL}/api/server/packs`));
}

export async function togglePack(
  type: PackType,
  uuid: string,
  active: boolean,
): Promise<PackToggleResponse> {
  return parseJson<PackToggleResponse>(
    await fetch(`${API_BASE_URL}/api/server/packs/${type}/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    }),
  );
}

export async function deletePack(type: PackType, uuid: string): Promise<PackDeleteResponse> {
  return parseJson<PackDeleteResponse>(
    await fetch(`${API_BASE_URL}/api/server/packs/${type}/${uuid}`, { method: 'DELETE' }),
  );
}

export async function uploadPacks(files: File[] | FileList): Promise<PackUploadResponse> {
  const list = Array.from(files);
  if (list.length === 0) {
    throw new Error('No pack files selected.');
  }

  const form = new FormData();
  for (const file of list) {
    form.append('pack', file);
  }
  const res = await fetch(`${API_BASE_URL}/api/server/packs/upload`, {
    method: 'POST',
    body: form,
  });
  return parseJson<PackUploadResponse>(res);
}

export function packIconUrl(type: PackType, uuid: string): string {
  return `${API_BASE_URL}/api/server/packs/icon/${type}/${uuid}`;
}

export function worldIconUrl(path: string): string {
  const query = new URLSearchParams({ path });
  return `${API_BASE_URL}/api/server/worlds/icon?${query.toString()}`;
}

// Re-export BedrockPack so consumers can import from api.ts (kept for back-compat)
// The canonical re-export is at the bottom of the file.

export async function fetchServerFiles(path = '.'): Promise<ServerFilesListResponse> {
  const query = new URLSearchParams({ path });
  return parseJson<ServerFilesListResponse>(
    await fetch(`${API_BASE_URL}/api/server/files?${query.toString()}`),
  );
}

export async function readServerTextFile(path: string): Promise<ServerFileTextResponse> {
  return parseJson<ServerFileTextResponse>(
    await fetch(`${API_BASE_URL}/api/server/files/text/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function writeServerTextFile(
  path: string,
  content: string,
): Promise<ServerFileActionResponse> {
  return parseJson<ServerFileActionResponse>(
    await fetch(`${API_BASE_URL}/api/server/files/text/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
  );
}

export async function createServerFolder(path: string, name: string): Promise<ServerFileActionResponse> {
  return parseJson<ServerFileActionResponse>(
    await fetch(`${API_BASE_URL}/api/server/files/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name }),
    }),
  );
}

export async function renameServerPath(path: string, newName: string): Promise<ServerFileActionResponse> {
  return parseJson<ServerFileActionResponse>(
    await fetch(`${API_BASE_URL}/api/server/files/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, newName }),
    }),
  );
}

export async function deleteServerPath(path: string): Promise<ServerFileActionResponse> {
  return parseJson<ServerFileActionResponse>(
    await fetch(`${API_BASE_URL}/api/server/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function uploadServerFile(path: string, file: File): Promise<ServerFileActionResponse> {
  const form = new FormData();
  form.append('path', path);
  form.append('file', file);
  const res = await fetch(`${API_BASE_URL}/api/server/files/upload`, {
    method: 'POST',
    body: form,
  });
  return parseJson<ServerFileActionResponse>(res);
}

export function serverFileDownloadUrl(path: string): string {
  const query = new URLSearchParams({ path });
  return `${API_BASE_URL}/api/server/files/download?${query.toString()}`;
}

export function serverFolderZipUrl(path: string): string {
  const query = new URLSearchParams({ path });
  return `${API_BASE_URL}/api/server/files/download-zip?${query.toString()}`;
}

// ── Downloads ──────────────────────────────────────────────────────────────────

export async function fetchDownloads(): Promise<DownloadsListResponse> {
  return parseJson<DownloadsListResponse>(await fetch(`${API_BASE_URL}/api/server/downloads`));
}

export function downloadIconUrl(filename: string): string {
  return `${API_BASE_URL}/api/server/downloads/icon/${encodeURIComponent(filename)}`;
}

export async function deleteDownload(filename: string): Promise<void> {
  await parseJson(await fetch(`${API_BASE_URL}/api/server/downloads/${encodeURIComponent(filename)}`, { method: 'DELETE' }));
}

export async function installFromDownloads(filename: string): Promise<DownloadInstallResponse> {
  return parseJson<DownloadInstallResponse>(
    await fetch(`${API_BASE_URL}/api/server/downloads/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    }),
  );
}

// Re-export types needed by consumers
export type { BedrockPack, DownloadEntry };

export function connectLogs(onMessage: (event: LogEvent) => void): () => void {
  const source = new EventSource(`${API_BASE_URL}/api/server/logs`);

  source.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data) as LogEvent;
      onMessage(payload);
    } catch {
      onMessage({
        kind: 'log',
        at: new Date().toISOString(),
        line: `Malformed log payload: ${message.data}`,
      });
    }
  };

  source.onerror = () => {
    onMessage({
      kind: 'log',
      at: new Date().toISOString(),
      line: 'Log stream disconnected. Retrying automatically...',
    });
  };

  return () => {
    source.close();
  };
}
