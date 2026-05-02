import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import type { InstallerActionResponse, InstallerStatusResponse } from '@bedrock-panel/shared';

interface BedrockInstallerConfig {
  bedrockServerDir: string;
  bedrockServerExe: string;
  bedrockDownloadUrl: string;
}

interface ResolvedDownload {
  url: string;
  source: 'override' | 'config' | 'autodiscover';
}

let installerConfig: BedrockInstallerConfig | null = null;
let isInstalling = false;
let lastInstallAt: string | null = null;
let lastResolvedDownloadUrl: string | null = null;

const officialDownloadPages = [
  'https://www.minecraft.net/en-us/download/server/bedrock',
  'https://www.minecraft.net/en-us/download/server/bedrock/',
];

const officialDiscoveryEndpoint =
  'https://client.discovery.minecraft-services.net/api/v1.0/discovery/web/builds/1.0.0.0';
const fallbackServiceUri = 'https://net-secondary.web.minecraft-services.net';

function assertInstallerConfig(): BedrockInstallerConfig {
  if (!installerConfig) {
    throw new Error('Installer is not configured.');
  }

  return installerConfig;
}

function resolveExecutablePath(config: BedrockInstallerConfig): string {
  return isAbsolute(config.bedrockServerExe)
    ? config.bedrockServerExe
    : resolve(config.bedrockServerDir, config.bedrockServerExe);
}

function resolveVersionFilePath(config: BedrockInstallerConfig): string {
  return resolve(config.bedrockServerDir, 'version.txt');
}

function getInstalledVersionInternal(config: BedrockInstallerConfig): string | null {
  const executablePath = resolveExecutablePath(config);
  if (!existsSync(executablePath)) {
    return null;
  }

  const versionFilePath = resolveVersionFilePath(config);
  if (!existsSync(versionFilePath)) {
    return 'installed';
  }

  const versionText = readFileSync(versionFilePath, 'utf8').trim();
  return versionText.length > 0 ? versionText : 'installed';
}

async function downloadArchive(downloadUrl: string, targetZipPath: string): Promise<void> {
  const response = await fetch(downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Bedrock archive: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  writeFileSync(targetZipPath, Buffer.from(arrayBuffer));
}

function extractArchive(archivePath: string, destinationDir: string): void {
  const archive = new AdmZip(archivePath);
  archive.extractAllTo(destinationDir, true);
}

function decodeEscapedContent(value: string): string {
  return value.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
}

function compareVersion(a: string, b: string): number {
  const aParts = a.split('.').map((part) => Number.parseInt(part, 10));
  const bParts = b.split('.').map((part) => Number.parseInt(part, 10));
  const size = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < size; i += 1) {
    const aValue = aParts[i] ?? 0;
    const bValue = bParts[i] ?? 0;
    if (aValue !== bValue) {
      return aValue - bValue;
    }
  }

  return 0;
}

function pickBestCandidate(candidates: string[]): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const unique = [...new Set(candidates)];

  unique.sort((left, right) => {
    const leftVersion = /bedrock-server-([0-9.]+)\.zip/i.exec(left)?.[1] ?? '';
    const rightVersion = /bedrock-server-([0-9.]+)\.zip/i.exec(right)?.[1] ?? '';
    return compareVersion(rightVersion, leftVersion);
  });

  return unique[0] ?? null;
}

function extractVersionFromDownloadUrl(downloadUrl: string): string | null {
  const match = /bedrock-server-([0-9.]+)\.zip/i.exec(downloadUrl);
  return match?.[1] ?? null;
}

function isVersionString(value: string | null): value is string {
  return !!value && /^\d+(\.\d+)+$/.test(value);
}

async function discoverLatestDownloadUrl(): Promise<string> {
  let servicesErrorMessage = '';
  try {
    const fromServices = await discoverLatestDownloadUrlFromServices();
    if (fromServices) {
      return fromServices;
    }
  } catch (cause) {
    servicesErrorMessage = cause instanceof Error ? cause.message : 'unknown services discovery error';
  }

  const discovered: string[] = [];

  for (const pageUrl of officialDownloadPages) {
    let html = '';
    try {
      const response = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'BedrockPanel/0.1 (+autodiscovery)',
        },
      });

      if (!response.ok) {
        continue;
      }

      html = decodeEscapedContent(await response.text());
    } catch {
      continue;
    }

    const absoluteWinMatches =
      html.match(/https?:\/\/[^"'<>\s]+\/bedrockdedicatedserver\/bin-win\/bedrock-server-[^"'<>\s]+?\.zip/gi) ?? [];
    const relativeWinMatches =
      html.match(/\/bedrockdedicatedserver\/bin-win\/bedrock-server-[^"'<>\s]+?\.zip/gi) ?? [];
    const genericMatches = html.match(/https?:\/\/[^"'<>\s]+bedrock[^"'<>\s]+\.zip/gi) ?? [];

    for (const candidate of [...absoluteWinMatches, ...genericMatches]) {
      const cleaned = candidate.replace(/&amp;/g, '&');
      if (/\.zip($|\?)/i.test(cleaned) && /bedrock/i.test(cleaned)) {
        discovered.push(cleaned);
      }
    }

    for (const candidate of relativeWinMatches) {
      const cleaned = candidate.replace(/&amp;/g, '&');
      discovered.push(`https://www.minecraft.net${cleaned}`);
    }
  }

  const best = pickBestCandidate(discovered);
  if (!best) {
    throw new Error(
      `Unable to auto-discover the official Bedrock server download URL. Provide BEDROCK_DOWNLOAD_URL or a downloadUrl override. Services discovery error: ${servicesErrorMessage || 'none'}`,
    );
  }

  return best;
}

async function discoverLatestDownloadUrlFromServices(): Promise<string | null> {
  const discoveryResponse = await fetch(officialDiscoveryEndpoint, {
    headers: {
      'User-Agent': 'BedrockPanel/0.1 (+autodiscovery)',
    },
  });

  let serviceUri = fallbackServiceUri;
  if (discoveryResponse.ok) {
    const discoveryJson = (await discoveryResponse.json()) as {
      result?: {
        serviceEnvironments?: {
          net?: {
            prod?: {
              serviceUri?: string;
            };
          };
        };
      };
    };

    const discoveredServiceUri =
      discoveryJson.result?.serviceEnvironments?.net?.prod?.serviceUri?.trim();
    if (discoveredServiceUri) {
      serviceUri = discoveredServiceUri;
    }
  }

  const linksResponse = await fetch(`${serviceUri}/api/v1.0/download/links`, {
    headers: {
      'User-Agent': 'BedrockPanel/0.1 (+autodiscovery)',
    },
  });

  if (!linksResponse.ok) {
    return null;
  }

  const linksJson = (await linksResponse.json()) as {
    result?: {
      links?: Array<{
        downloadType?: string;
        downloadUrl?: string;
      }>;
    };
  };

  const windowsLink = linksJson.result?.links?.find(
    (entry) => entry.downloadType === 'serverBedrockWindows' && !!entry.downloadUrl,
  );

  return windowsLink?.downloadUrl?.trim() || null;
}

async function resolveDownloadUrl(downloadUrlOverride?: string): Promise<ResolvedDownload> {
  const config = assertInstallerConfig();
  const override = (downloadUrlOverride ?? '').trim();
  if (override) {
    return { url: override, source: 'override' };
  }

  const configured = config.bedrockDownloadUrl.trim();
  if (configured) {
    return { url: configured, source: 'config' };
  }

  const discovered = await discoverLatestDownloadUrl();
  return { url: discovered, source: 'autodiscover' };
}

export async function previewResolvedDownloadUrl(downloadUrlOverride?: string): Promise<string> {
  const resolved = await resolveDownloadUrl(downloadUrlOverride);
  return resolved.url;
}

export function configureBedrockInstaller(config: BedrockInstallerConfig): void {
  installerConfig = config;
}

export function getBedrockInstallerStatus(): InstallerStatusResponse {
  const config = assertInstallerConfig();
  const executablePath = resolveExecutablePath(config);
  const installedVersion = getInstalledVersionInternal(config);

  return {
    installed: existsSync(executablePath),
    installedVersion,
    executablePath,
    downloadUrlConfigured: config.bedrockDownloadUrl.trim().length > 0,
    isInstalling,
    lastInstallAt,
    lastResolvedDownloadUrl,
  };
}

export async function installOrUpdateBedrockServer(
  downloadUrlOverride?: string,
): Promise<InstallerActionResponse> {
  const config = assertInstallerConfig();
  if (isInstalling) {
    return {
      accepted: true,
      message: 'Installation already in progress.',
      installed: getBedrockInstallerStatus().installed,
      installedVersion: getBedrockInstallerStatus().installedVersion,
    };
  }

  const statusBeforeInstall = getBedrockInstallerStatus();
  const hasManualOverride = (downloadUrlOverride ?? '').trim().length > 0;

  const resolvedDownload = await resolveDownloadUrl(downloadUrlOverride);
  const downloadUrl = resolvedDownload.url;
  lastResolvedDownloadUrl = downloadUrl;

  const candidateVersion = extractVersionFromDownloadUrl(downloadUrl);
  if (statusBeforeInstall.installed && !hasManualOverride) {
    const installedVersion = statusBeforeInstall.installedVersion;

    if (isVersionString(installedVersion) && isVersionString(candidateVersion)) {
      const comparison = compareVersion(candidateVersion, installedVersion);
      if (comparison <= 0) {
        return {
          accepted: true,
          message: `Bedrock server is already up to date (installed ${installedVersion}, candidate ${candidateVersion}).`,
          installed: statusBeforeInstall.installed,
          installedVersion: statusBeforeInstall.installedVersion,
        };
      }
    } else if (!candidateVersion) {
      return {
        accepted: true,
        message: 'Bedrock server is already installed. Skipping automatic reinstall because the download version could not be verified.',
        installed: statusBeforeInstall.installed,
        installedVersion: statusBeforeInstall.installedVersion,
      };
    } else {
      return {
        accepted: true,
        message: 'Bedrock server is already installed. Provide a manual override URL to force reinstall/update.',
        installed: statusBeforeInstall.installed,
        installedVersion: statusBeforeInstall.installedVersion,
      };
    }
  }

  mkdirSync(config.bedrockServerDir, { recursive: true });

  const archiveName = basename(new URL(downloadUrl).pathname) || 'bedrock-server.zip';
  const archivePath = resolve(config.bedrockServerDir, archiveName);

  isInstalling = true;
  try {
    await downloadArchive(downloadUrl, archivePath);
    extractArchive(archivePath, config.bedrockServerDir);
    lastInstallAt = new Date().toISOString();
  } finally {
    isInstalling = false;
    if (existsSync(archivePath)) {
      unlinkSync(archivePath);
    }
  }

  const status = getBedrockInstallerStatus();
  return {
    accepted: true,
    message: `Bedrock server package installed to ${config.bedrockServerDir} (source: ${resolvedDownload.source})`,
    installed: status.installed,
    installedVersion: status.installedVersion,
  };
}
