import { readFile, writeFile, rm, access } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import AdmZip from 'adm-zip';
import type { BedrockPack, PackType } from '@bedrock-panel/shared';

let serverDir = '';

export function configurePacksService(config: { bedrockServerDir: string }): void {
  serverDir = config.bedrockServerDir;
}

// ---------------------------------------------------------------------------
// Built-in pack folder prefixes to exclude from user-facing lists
// ---------------------------------------------------------------------------
const BUILTIN_PREFIXES = [
  'vanilla',
  'chemistry',
  'editor',
  'experimental_',
  'server_',
];

function isBuiltIn(folderName: string): boolean {
  const lower = folderName.toLowerCase();
  return BUILTIN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------
interface PackManifest {
  header: {
    uuid: string;
    name: string;
    description?: string;
    version: [number, number, number];
  };
}

async function readManifest(packDir: string): Promise<PackManifest | null> {
  const manifestPath = join(packDir, 'manifest.json');
  try {
    await access(manifestPath);
    const raw = await readFile(manifestPath, 'utf-8');
    return JSON.parse(raw) as PackManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Active pack list (world_behavior_packs.json / world_resource_packs.json)
// ---------------------------------------------------------------------------
interface ActivePackEntry {
  pack_id: string;
  version: [number, number, number];
}

async function getWorldName(): Promise<string> {
  try {
    const propPath = join(serverDir, 'server.properties');
    const raw = await readFile(propPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('level-name')) {
        const [, ...rest] = trimmed.split('=');
        return rest.join('=').trim() || 'Bedrock level';
      }
    }
  } catch {
    // fall through
  }
  return 'Bedrock level';
}

function worldPacksPath(worldName: string, type: PackType): string {
  const fileName = type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
  return join(serverDir, 'worlds', worldName, fileName);
}

async function readActivePackIds(worldName: string, type: PackType): Promise<Set<string>> {
  try {
    const raw = await readFile(worldPacksPath(worldName, type), 'utf-8');
    const entries = JSON.parse(raw) as ActivePackEntry[];
    return new Set(entries.map((e) => e.pack_id));
  } catch {
    return new Set();
  }
}

async function readActivePackEntries(worldName: string, type: PackType): Promise<ActivePackEntry[]> {
  try {
    const raw = await readFile(worldPacksPath(worldName, type), 'utf-8');
    return JSON.parse(raw) as ActivePackEntry[];
  } catch {
    return [];
  }
}

async function writeActivePackEntries(
  worldName: string,
  type: PackType,
  entries: ActivePackEntry[]
): Promise<void> {
  const filePath = worldPacksPath(worldName, type);
  // Ensure the world directory exists (it should, but just in case)
  const worldDir = join(serverDir, 'worlds', worldName);
  if (!existsSync(worldDir)) mkdirSync(worldDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Scan a pack directory for user-installed packs
// ---------------------------------------------------------------------------
async function scanPackDir(type: PackType, activeIds: Set<string>): Promise<BedrockPack[]> {
  const dirName = type === 'behavior' ? 'behavior_packs' : 'resource_packs';
  const packsDir = join(serverDir, dirName);

  let folders: string[] = [];
  try {
    folders = readdirSync(packsDir).filter((name) => {
      if (isBuiltIn(name)) return false;
      const fullPath = join(packsDir, name);
      return statSync(fullPath).isDirectory();
    });
  } catch {
    return [];
  }

  const packs: BedrockPack[] = [];
  for (const folder of folders) {
    const manifest = await readManifest(join(packsDir, folder));
    if (!manifest) continue;
    const { uuid, name, description, version } = manifest.header;
    packs.push({
      uuid,
      type,
      name: name || folder,
      description: description || '',
      version: version ?? [1, 0, 0],
      folderName: folder,
      active: activeIds.has(uuid),
    });
  }
  return packs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function getPackIconPath(type: PackType, uuid: string): Promise<string | null> {
  const dirName = type === 'behavior' ? 'behavior_packs' : 'resource_packs';
  const packsDir = join(serverDir, dirName);
  const folders = readdirSync(packsDir);
  for (const folder of folders) {
    const manifest = await readManifest(join(packsDir, folder));
    if (manifest?.header.uuid === uuid) {
      const iconPath = join(packsDir, folder, 'pack_icon.png');
      try {
        await access(iconPath);
        return iconPath;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function listPacks(): Promise<{
  behaviorPacks: BedrockPack[];
  resourcePacks: BedrockPack[];
  worldName: string;
}> {
  const worldName = await getWorldName();
  const [bpActive, rpActive] = await Promise.all([
    readActivePackIds(worldName, 'behavior'),
    readActivePackIds(worldName, 'resource'),
  ]);
  const [behaviorPacks, resourcePacks] = await Promise.all([
    scanPackDir('behavior', bpActive),
    scanPackDir('resource', rpActive),
  ]);
  return { behaviorPacks, resourcePacks, worldName };
}

export async function setPackActive(
  type: PackType,
  uuid: string,
  active: boolean
): Promise<void> {
  const worldName = await getWorldName();
  const entries = await readActivePackEntries(worldName, type);

  if (active) {
    // Add if not already present — find the version from manifest
    if (!entries.find((e) => e.pack_id === uuid)) {
      const dirName = type === 'behavior' ? 'behavior_packs' : 'resource_packs';
      const packsDir = join(serverDir, dirName);
      const folders = readdirSync(packsDir);
      let version: [number, number, number] = [1, 0, 0];
      for (const folder of folders) {
        const manifest = await readManifest(join(packsDir, folder));
        if (manifest?.header.uuid === uuid) {
          version = manifest.header.version ?? [1, 0, 0];
          break;
        }
      }
      entries.push({ pack_id: uuid, version });
    }
  } else {
    const idx = entries.findIndex((e) => e.pack_id === uuid);
    if (idx !== -1) entries.splice(idx, 1);
  }

  await writeActivePackEntries(worldName, type, entries);
}

export async function deletePack(type: PackType, uuid: string): Promise<void> {
  const worldName = await getWorldName();
  const dirName = type === 'behavior' ? 'behavior_packs' : 'resource_packs';
  const packsDir = join(serverDir, dirName);

  // Find the folder with this UUID
  const folders = readdirSync(packsDir);
  let targetFolder: string | null = null;
  for (const folder of folders) {
    const manifest = await readManifest(join(packsDir, folder));
    if (manifest?.header.uuid === uuid) {
      targetFolder = folder;
      break;
    }
  }

  if (!targetFolder) throw new Error(`Pack ${uuid} not found`);
  await rm(join(packsDir, targetFolder), { recursive: true, force: true });

  // Also remove from active list if present
  const entries = await readActivePackEntries(worldName, type);
  const filtered = entries.filter((e) => e.pack_id !== uuid);
  await writeActivePackEntries(worldName, type, filtered);
}

// ---------------------------------------------------------------------------
// Upload — handles .mcpack (single pack zip) and .mcaddon (zip of packs)
// ---------------------------------------------------------------------------
export async function installPackBuffer(
  buffer: Buffer,
  originalName: string
): Promise<BedrockPack[]> {
  const ext = originalName.toLowerCase().endsWith('.mcaddon') ? 'mcaddon' : 'mcpack';
  const zip = new AdmZip(buffer);
  const installed: BedrockPack[] = [];

  if (ext === 'mcpack') {
    // A single pack — extract directly to behavior_packs or resource_packs
    const pack = await extractSinglePack(zip, buffer);
    if (pack) installed.push(pack);
  } else {
    // .mcaddon — may contain multiple .mcpack files inside
    const entries = zip.getEntries();
    const innerPacks = entries.filter(
      (e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.mcpack')
    );

    if (innerPacks.length === 0) {
      // Some .mcaddon files are flat bundles with one or many pack roots.
      const manifestEntries = entries.filter(
        (e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('manifest.json')
      );

      if (manifestEntries.length <= 1) {
        const pack = await extractSinglePack(zip, buffer);
        if (pack) installed.push(pack);
      } else {
        const handledPrefixes = new Set<string>();
        for (const manifestEntry of manifestEntries) {
          const prefix = manifestEntry.entryName.replace(/manifest\.json$/i, '');
          if (handledPrefixes.has(prefix)) continue;
          handledPrefixes.add(prefix);

          const subZip = new AdmZip();
          for (const entry of entries) {
            if (entry.isDirectory) continue;
            if (!entry.entryName.startsWith(prefix)) continue;
            const relPath = entry.entryName.slice(prefix.length);
            if (!relPath) continue;
            subZip.addFile(relPath, entry.getData());
          }

          const pack = await extractSinglePack(subZip, Buffer.alloc(0));
          if (pack) installed.push(pack);
        }
      }
    } else {
      for (const innerEntry of innerPacks) {
        const innerBuf = innerEntry.getData();
        const innerZip = new AdmZip(innerBuf);
        const pack = await extractSinglePack(innerZip, innerBuf);
        if (pack) installed.push(pack);
      }
    }
  }

  return installed;
}

async function extractSinglePack(
  zip: AdmZip,
  _buffer: Buffer
): Promise<BedrockPack | null> {
  // Detect pack type from manifest.json
  let manifestEntry = zip.getEntry('manifest.json');
  
  // Some packs nest everything in a subdirectory
  let prefix = '';
  if (!manifestEntry) {
    const entries = zip.getEntries();
    const manifestEntry2 = entries.find((e) => e.entryName.endsWith('manifest.json'));
    if (manifestEntry2) {
      prefix = manifestEntry2.entryName.replace('manifest.json', '');
      manifestEntry = manifestEntry2;
    }
  }

  if (!manifestEntry) return null;

  let manifest: PackManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as PackManifest;
  } catch {
    return null;
  }

  const { uuid, name, description, version } = manifest.header;

  // Determine type from modules
  type ModuleType = { type: string; [key: string]: unknown };
  const rawZip = zip as unknown as { toJSON?: () => unknown };
  void rawZip;
  const allEntries = zip.getEntries();
  let packType: PackType = 'behavior';
  try {
    const fullManifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as {
      modules?: ModuleType[];
    };
    const moduleTypes = (fullManifest.modules ?? []).map((m: ModuleType) =>
      (m.type as string).toLowerCase()
    );
    if (moduleTypes.some((t: string) => ['resources', 'skin_pack', 'persona_piece'].includes(t))) {
      packType = 'resource';
    }
  } catch {
    // default to behavior
  }

  const dirName = packType === 'behavior' ? 'behavior_packs' : 'resource_packs';
  const packsDir = join(serverDir, dirName);
  const folderName = sanitizeFolderName(name || uuid);
  const destDir = join(packsDir, folderName);

  // Extract all entries under the prefix to destDir
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  for (const entry of allEntries) {
    if (entry.isDirectory) continue;
    const relPath = prefix ? entry.entryName.slice(prefix.length) : entry.entryName;
    if (!relPath) continue;
    const destPath = join(destDir, relPath);
    const destDirPath = destPath.substring(0, destPath.lastIndexOf('/') === -1 ? destPath.lastIndexOf('\\') : destPath.lastIndexOf('/'));
    if (destDirPath && !existsSync(destDirPath)) mkdirSync(destDirPath, { recursive: true });
    await writeFile(destPath, entry.getData());
  }

  return {
    uuid,
    type: packType,
    name: name || folderName,
    description: description || '',
    version: version ?? [1, 0, 0],
    folderName,
    active: false,
  };
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_').slice(0, 64) || 'pack';
}
