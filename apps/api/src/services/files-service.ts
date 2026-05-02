import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { DownloadEntry, ServerFileEntry } from '@bedrock-panel/shared';
import AdmZip from 'adm-zip';

interface FilesServiceConfig {
  bedrockServerDir: string;
}

let rootDir = '';

const windowsReservedNames = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const textExtensions = new Set([
  '.txt',
  '.json',
  '.properties',
  '.mcfunction',
  '.yml',
  '.yaml',
  '.ini',
  '.cfg',
  '.xml',
  '.md',
  '.log',
]);

export function configureFilesService(config: FilesServiceConfig): void {
  rootDir = resolve(config.bedrockServerDir);
}

function assertConfigured(): string {
  if (!rootDir) {
    throw new Error('Files service is not configured.');
  }

  return rootDir;
}

function normalizeRelativePath(inputPath?: string): string {
  const value = (inputPath ?? '.').trim();
  if (!value || value === '.') {
    return '.';
  }

  if (value.includes('\0')) {
    throw new Error('Path cannot contain null bytes.');
  }

  return normalize(value).replace(/\\/g, '/');
}

function validatePathName(rawName: string, subject: 'Folder name' | 'New name' | 'File name'): string {
  const value = rawName.trim();
  if (!value) {
    throw new Error(`${subject} is required.`);
  }

  if (value === '.' || value === '..') {
    throw new Error(`${subject} cannot be . or ..`);
  }

  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`${subject} cannot contain path separators.`);
  }

  if (/[<>:"|?*]/.test(value)) {
    throw new Error(`${subject} contains invalid characters (< > : " | ? *).`);
  }

  if (/[\u0000-\u001f]/.test(value)) {
    throw new Error(`${subject} contains control characters.`);
  }

  if (/[. ]$/.test(value)) {
    throw new Error(`${subject} cannot end with a dot or space.`);
  }

  const baseName = value.split('.')[0]?.toLowerCase() ?? '';
  if (windowsReservedNames.has(baseName)) {
    throw new Error(`${subject} uses a reserved Windows device name.`);
  }

  return value;
}

function toFriendlyFsError(error: unknown, context: string): Error {
  if (!error || typeof error !== 'object') {
    return new Error(context);
  }

  const maybeCode = 'code' in error ? (error as { code?: unknown }).code : undefined;
  const code = typeof maybeCode === 'string' ? maybeCode : '';
  switch (code) {
    case 'EEXIST':
      return new Error('An item with that name already exists.');
    case 'ENOENT':
      return new Error('The target path no longer exists. Please refresh and try again.');
    case 'ENOTEMPTY':
      return new Error('Target directory is not empty.');
    case 'EACCES':
    case 'EPERM':
      return new Error('Operation blocked by filesystem permissions.');
    case 'EINVAL':
      return new Error('Invalid file or directory name.');
    default:
      return new Error(context);
  }
}

function resolveInsideRoot(relativePath?: string): { absolutePath: string; normalizedRelativePath: string } {
  const base = assertConfigured();
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  if (isAbsolute(normalizedRelativePath)) {
    throw new Error('Absolute paths are not allowed.');
  }

  const absolutePath = resolve(base, normalizedRelativePath);
  const relFromBase = relative(base, absolutePath);
  if (relFromBase.startsWith('..') || relFromBase.includes(':')) {
    throw new Error('Path escapes server root.');
  }

  return {
    absolutePath,
    normalizedRelativePath: relFromBase ? relFromBase.replace(/\\/g, '/') : '.',
  };
}

function toFileEntry(root: string, parentAbsPath: string, name: string, stats: Awaited<ReturnType<typeof stat>>): ServerFileEntry {
  const fullPath = join(parentAbsPath, name);
  const relPath = relative(root, fullPath).replace(/\\/g, '/');
  const sizeValue = stats.isDirectory() ? null : Number(stats.size);
  return {
    name,
    relativePath: relPath || '.',
    kind: stats.isDirectory() ? 'directory' : 'file',
    sizeBytes: Number.isFinite(sizeValue ?? 0) ? sizeValue : null,
    modifiedAt: stats.mtime.toISOString(),
  };
}

export async function listServerFiles(relativePath?: string): Promise<{
  currentPath: string;
  parentPath: string | null;
  entries: ServerFileEntry[];
}> {
  const root = assertConfigured();
  const { absolutePath, normalizedRelativePath } = resolveInsideRoot(relativePath);
  const dirStats = await stat(absolutePath);
  if (!dirStats.isDirectory()) {
    throw new Error('Requested path is not a directory.');
  }

  const names = await readdir(absolutePath);
  const entries: ServerFileEntry[] = [];
  for (const name of names) {
    const entryStats = await stat(join(absolutePath, name));
    entries.push(toFileEntry(root, absolutePath, name, entryStats));
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

  const parentPath = normalizedRelativePath === '.'
    ? null
    : normalize(dirname(normalizedRelativePath)).replace(/\\/g, '/');

  return {
    currentPath: normalizedRelativePath,
    parentPath: parentPath === '.' ? '.' : parentPath,
    entries,
  };
}

export async function readServerTextFile(relativePath: string): Promise<string> {
  const { absolutePath } = resolveInsideRoot(relativePath);
  const extension = extname(absolutePath).toLowerCase();
  if (!textExtensions.has(extension)) {
    throw new Error(`Editing is only allowed for text file types (${extension || 'no extension'}).`);
  }

  return readFile(absolutePath, 'utf-8');
}

export async function writeServerTextFile(relativePath: string, content: string): Promise<void> {
  const { absolutePath } = resolveInsideRoot(relativePath);
  const extension = extname(absolutePath).toLowerCase();
  if (!textExtensions.has(extension)) {
    throw new Error(`Editing is only allowed for text file types (${extension || 'no extension'}).`);
  }

  await writeFile(absolutePath, content, 'utf-8');
}

export async function createServerDirectory(relativePath: string, name: string): Promise<void> {
  const folderName = validatePathName(name, 'Folder name');

  const { absolutePath } = resolveInsideRoot(relativePath);
  try {
    await mkdir(join(absolutePath, folderName), { recursive: false });
  } catch (error) {
    throw toFriendlyFsError(error, 'Failed to create folder.');
  }
}

export async function renameServerPath(relativePath: string, newName: string): Promise<void> {
  const targetName = validatePathName(newName, 'New name');

  const { absolutePath } = resolveInsideRoot(relativePath);
  const destination = join(dirname(absolutePath), targetName);

  const root = assertConfigured();
  const relFromBase = relative(root, destination);
  if (relFromBase.startsWith('..') || relFromBase.includes(':')) {
    throw new Error('Rename target escapes server root.');
  }

  try {
    await rename(absolutePath, destination);
  } catch (error) {
    throw toFriendlyFsError(error, 'Failed to rename item.');
  }
}

export async function deleteServerPath(relativePath: string): Promise<void> {
  const { absolutePath, normalizedRelativePath } = resolveInsideRoot(relativePath);
  if (normalizedRelativePath === '.') {
    throw new Error('Cannot delete server root.');
  }

  await rm(absolutePath, { recursive: true, force: false });
}

export async function writeUploadedFile(relativeDirectoryPath: string, originalName: string, buffer: Buffer): Promise<void> {
  const fileName = validatePathName(originalName, 'File name');

  const { absolutePath, normalizedRelativePath } = resolveInsideRoot(relativeDirectoryPath);

  // .mcworld files are ZIP archives that must be extracted into a subfolder under worlds/
  if (fileName.toLowerCase().endsWith('.mcworld') && normalizedRelativePath === 'worlds') {
    const worldFolderName = fileName.slice(0, -'.mcworld'.length);
    const extractTarget = join(absolutePath, worldFolderName);
    try {
      await mkdir(extractTarget, { recursive: true });
      const zip = new AdmZip(buffer);
      zip.extractAllTo(extractTarget, true);
    } catch (error) {
      throw toFriendlyFsError(error, 'Failed to extract .mcworld file.');
    }
    return;
  }

  const targetPath = join(absolutePath, fileName);
  try {
    await writeFile(targetPath, buffer);
  } catch (error) {
    throw toFriendlyFsError(error, 'Failed to upload file.');
  }
}

export function getServerFileDownloadPath(relativePath: string): string {
  const { absolutePath } = resolveInsideRoot(relativePath);
  return absolutePath;
}

export async function getServerFolderZipBuffer(relativePath: string): Promise<{ buffer: Buffer; folderName: string }> {
  const { absolutePath, normalizedRelativePath } = resolveInsideRoot(relativePath);
  const dirStats = await stat(absolutePath);
  if (!dirStats.isDirectory()) {
    throw new Error('Path is not a directory.');
  }

  const zip = new AdmZip();
  zip.addLocalFolder(absolutePath);
  const folderName = normalizedRelativePath === '.' ? 'server-root' : (normalizedRelativePath.split('/').pop() ?? 'folder');
  return { buffer: zip.toBuffer(), folderName };
}

// ── Downloads folder helpers ──────────────────────────────────────────────────

function getDownloadsDir(): string {
  return join(assertConfigured(), 'downloads');
}

export async function listDownloads(): Promise<DownloadEntry[]> {
  const dir = getDownloadsDir();
  try {
    await mkdir(dir, { recursive: true });
    const names = await readdir(dir);
    const entries: DownloadEntry[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.mcpack') && !lower.endsWith('.mcaddon')) continue;
      try {
        const s = await stat(join(dir, name));
        if (!s.isFile()) continue;
        entries.push({ filename: name, sizeBytes: Number(s.size), modifiedAt: s.mtime.toISOString() });
      } catch { /* skip */ }
    }
    entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return entries;
  } catch {
    return [];
  }
}

export async function deleteDownloadFile(filename: string): Promise<void> {
  const safe = validatePathName(filename, 'File name');
  const lower = safe.toLowerCase();
  if (!lower.endsWith('.mcpack') && !lower.endsWith('.mcaddon')) {
    throw new Error('Only .mcpack and .mcaddon files can be deleted from downloads.');
  }
  const filePath = join(getDownloadsDir(), safe);
  // Ensure it's inside downloads dir
  const rel = relative(getDownloadsDir(), filePath);
  if (rel.startsWith('..') || rel.includes(':')) throw new Error('Invalid filename.');
  await rm(filePath, { force: false });
}

export async function readDownloadBuffer(filename: string): Promise<{ buffer: Buffer; filename: string }> {
  const safe = validatePathName(filename, 'File name');
  const filePath = join(getDownloadsDir(), safe);
  const rel = relative(getDownloadsDir(), filePath);
  if (rel.startsWith('..') || rel.includes(':')) throw new Error('Invalid filename.');
  const buffer = await readFile(filePath);
  return { buffer, filename: safe };
}

export async function getDownloadIconBuffer(filename: string): Promise<Buffer | null> {
  try {
    const { buffer } = await readDownloadBuffer(filename);
    const zip = new AdmZip(buffer);
    // Try root icon first, then nested
    const candidates = ['pack_icon.png', ...zip.getEntries().map(e => e.entryName).filter(n => n.endsWith('pack_icon.png'))];
    for (const candidate of candidates) {
      const entry = zip.getEntry(candidate);
      if (entry && !entry.isDirectory) return entry.getData();
    }
  } catch { /* no icon */ }
  return null;
}

export async function getWorldIconBuffer(
  relativeWorldPath: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const { absolutePath, normalizedRelativePath } = resolveInsideRoot(relativeWorldPath);
    const lower = normalizedRelativePath.toLowerCase();
    if (!lower.startsWith('worlds/') || normalizedRelativePath.split('/').length < 2) {
      return null;
    }

    const s = await stat(absolutePath);
    if (!s.isDirectory()) {
      return null;
    }

    const candidates: Array<{ name: string; contentType: string }> = [
      { name: 'world_icon.jpeg', contentType: 'image/jpeg' },
      { name: 'world_icon.jpg', contentType: 'image/jpeg' },
      { name: 'world_icon.png', contentType: 'image/png' },
    ];

    for (const candidate of candidates) {
      try {
        const buffer = await readFile(join(absolutePath, candidate.name));
        return { buffer, contentType: candidate.contentType };
      } catch {
        // Try next candidate.
      }
    }
  } catch {
    return null;
  }

  return null;
}
