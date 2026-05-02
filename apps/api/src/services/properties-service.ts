import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { BedrockServerProperties } from '@bedrock-panel/shared';

let serverDir = '';

export function configurePropertiesService(config: { bedrockServerDir: string }): void {
  serverDir = config.bedrockServerDir;
}

function propertiesFilePath(): string {
  return join(serverDir, 'server.properties');
}

// ---------------------------------------------------------------------------
// Defaults — matches official Bedrock server.properties
// ---------------------------------------------------------------------------
const DEFAULTS: BedrockServerProperties = {
  'server-name': 'Dedicated Server',
  'level-name': 'Bedrock level',
  'level-seed': '',
  gamemode: 'survival',
  difficulty: 'easy',
  'max-players': 10,
  'force-gamemode': false,
  'online-mode': true,
  'allow-cheats': false,
  'allow-list': false,
  'texturepack-required': false,
  'default-player-permission-level': 'member',
  'chat-restriction': 'None',
  'disable-custom-skins': false,
  'player-idle-timeout': 30,
  'disable-player-interaction': false,
  'server-port': 19132,
  'server-portv6': 19133,
  'enable-lan-visibility': true,
  'compression-threshold': 1,
  'compression-algorithm': 'zlib',
  'view-distance': 32,
  'tick-distance': 4,
  'max-threads': 8,
  'client-side-chunk-generation-enabled': true,
  'block-network-ids-are-hashes': true,
  'server-authoritative-movement-strict': false,
  'server-authoritative-dismount-strict': false,
  'server-authoritative-entity-interactions-strict': false,
  'player-position-acceptance-threshold': 0.5,
  'player-movement-action-direction-threshold': 0.85,
  'server-authoritative-block-breaking-pick-range-scalar': 1.5,
  'content-log-file-enabled': false,
  'content-log-console-output-enabled': false,
  'content-log-level': 'info',
};

// Keys we manage — any unlisted keys in the file are left untouched
const MANAGED_KEYS = new Set<string>(Object.keys(DEFAULTS));

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
function parseRaw(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1); // preserve value as-is (no trim for seeds)
    map.set(key, value);
  }
  return map;
}

function coerceBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v.toLowerCase() === 'true';
}

function coerceInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function coerceFloat(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapToProperties(raw: Map<string, string>): BedrockServerProperties {
  const g = (k: string) => raw.get(k);

  const gamemodeRaw = g('gamemode') ?? 'survival';
  const gamemode: BedrockServerProperties['gamemode'] = (
    ['survival', 'creative', 'adventure'] as const
  ).includes(gamemodeRaw as BedrockServerProperties['gamemode'])
    ? (gamemodeRaw as BedrockServerProperties['gamemode'])
    : 'survival';

  const difficultyRaw = g('difficulty') ?? 'easy';
  const difficulty: BedrockServerProperties['difficulty'] = (
    ['peaceful', 'easy', 'normal', 'hard'] as const
  ).includes(difficultyRaw as BedrockServerProperties['difficulty'])
    ? (difficultyRaw as BedrockServerProperties['difficulty'])
    : 'easy';

  const permLevelRaw = g('default-player-permission-level') ?? 'member';
  const defaultPlayerPermissionLevel: BedrockServerProperties['default-player-permission-level'] = (
    ['visitor', 'member', 'operator'] as const
  ).includes(permLevelRaw as BedrockServerProperties['default-player-permission-level'])
    ? (permLevelRaw as BedrockServerProperties['default-player-permission-level'])
    : 'member';

  const chatRaw = g('chat-restriction') ?? 'None';
  const chatRestriction: BedrockServerProperties['chat-restriction'] = (
    ['None', 'Dropped', 'Disabled'] as const
  ).includes(chatRaw as BedrockServerProperties['chat-restriction'])
    ? (chatRaw as BedrockServerProperties['chat-restriction'])
    : 'None';

  const comprAlgoRaw = g('compression-algorithm') ?? 'zlib';
  const compressionAlgorithm: BedrockServerProperties['compression-algorithm'] = (
    ['zlib', 'snappy'] as const
  ).includes(comprAlgoRaw as BedrockServerProperties['compression-algorithm'])
    ? (comprAlgoRaw as BedrockServerProperties['compression-algorithm'])
    : 'zlib';

  const logLevelRaw = g('content-log-level') ?? 'info';
  const contentLogLevel: BedrockServerProperties['content-log-level'] = (
    ['error', 'warning', 'info', 'verbose'] as const
  ).includes(logLevelRaw as BedrockServerProperties['content-log-level'])
    ? (logLevelRaw as BedrockServerProperties['content-log-level'])
    : 'info';

  return {
    'server-name': g('server-name') ?? DEFAULTS['server-name'],
    'level-name': g('level-name') ?? DEFAULTS['level-name'],
    'level-seed': g('level-seed') ?? '',
    gamemode,
    difficulty,
    'max-players': coerceInt(g('max-players'), DEFAULTS['max-players']),
    'force-gamemode': coerceBool(g('force-gamemode'), DEFAULTS['force-gamemode']),
    'online-mode': coerceBool(g('online-mode'), DEFAULTS['online-mode']),
    'allow-cheats': coerceBool(g('allow-cheats'), DEFAULTS['allow-cheats']),
    'allow-list': coerceBool(g('allow-list'), DEFAULTS['allow-list']),
    'texturepack-required': coerceBool(g('texturepack-required'), DEFAULTS['texturepack-required']),
    'default-player-permission-level': defaultPlayerPermissionLevel,
    'chat-restriction': chatRestriction,
    'disable-custom-skins': coerceBool(g('disable-custom-skins'), DEFAULTS['disable-custom-skins']),
    'player-idle-timeout': coerceInt(g('player-idle-timeout'), DEFAULTS['player-idle-timeout']),
    'disable-player-interaction': coerceBool(
      g('disable-player-interaction'),
      DEFAULTS['disable-player-interaction'],
    ),
    'server-port': coerceInt(g('server-port'), DEFAULTS['server-port']),
    'server-portv6': coerceInt(g('server-portv6'), DEFAULTS['server-portv6']),
    'enable-lan-visibility': coerceBool(g('enable-lan-visibility'), DEFAULTS['enable-lan-visibility']),
    'compression-threshold': coerceInt(g('compression-threshold'), DEFAULTS['compression-threshold']),
    'compression-algorithm': compressionAlgorithm,
    'view-distance': coerceInt(g('view-distance'), DEFAULTS['view-distance']),
    'tick-distance': coerceInt(g('tick-distance'), DEFAULTS['tick-distance']),
    'max-threads': coerceInt(g('max-threads'), DEFAULTS['max-threads']),
    'client-side-chunk-generation-enabled': coerceBool(
      g('client-side-chunk-generation-enabled'),
      DEFAULTS['client-side-chunk-generation-enabled'],
    ),
    'block-network-ids-are-hashes': coerceBool(
      g('block-network-ids-are-hashes'),
      DEFAULTS['block-network-ids-are-hashes'],
    ),
    'server-authoritative-movement-strict': coerceBool(
      g('server-authoritative-movement-strict'),
      DEFAULTS['server-authoritative-movement-strict'],
    ),
    'server-authoritative-dismount-strict': coerceBool(
      g('server-authoritative-dismount-strict'),
      DEFAULTS['server-authoritative-dismount-strict'],
    ),
    'server-authoritative-entity-interactions-strict': coerceBool(
      g('server-authoritative-entity-interactions-strict'),
      DEFAULTS['server-authoritative-entity-interactions-strict'],
    ),
    'player-position-acceptance-threshold': coerceFloat(
      g('player-position-acceptance-threshold'),
      DEFAULTS['player-position-acceptance-threshold'],
    ),
    'player-movement-action-direction-threshold': coerceFloat(
      g('player-movement-action-direction-threshold'),
      DEFAULTS['player-movement-action-direction-threshold'],
    ),
    'server-authoritative-block-breaking-pick-range-scalar': coerceFloat(
      g('server-authoritative-block-breaking-pick-range-scalar'),
      DEFAULTS['server-authoritative-block-breaking-pick-range-scalar'],
    ),
    'content-log-file-enabled': coerceBool(
      g('content-log-file-enabled'),
      DEFAULTS['content-log-file-enabled'],
    ),
    'content-log-console-output-enabled': coerceBool(
      g('content-log-console-output-enabled'),
      DEFAULTS['content-log-console-output-enabled'],
    ),
    'content-log-level': contentLogLevel,
  };
}

// ---------------------------------------------------------------------------
// Serialize — update managed key=value lines, preserve the rest
// ---------------------------------------------------------------------------
function serializeValue(value: string | number | boolean): string {
  return String(value);
}

function mergeIntoFile(original: string, updates: BedrockServerProperties): string {
  const lines = original.split(/\r?\n/);
  const written = new Set<string>();
  const updatesAsRecord = updates as unknown as Record<string, string | number | boolean>;

  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (MANAGED_KEYS.has(key)) {
      written.add(key);
      return `${key}=${serializeValue(updatesAsRecord[key] ?? '')}`;
    }
    return line;
  });

  // Append any managed keys not found in file
  for (const key of MANAGED_KEYS) {
    if (!written.has(key)) {
      result.push(`${key}=${serializeValue(updatesAsRecord[key] ?? '')}`);
    }
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function readServerProperties(): Promise<{
  properties: BedrockServerProperties;
  fileExists: boolean;
}> {
  const filePath = propertiesFilePath();

  let content: string;
  let fileExists = true;

  try {
    await access(filePath);
    content = await readFile(filePath, 'utf8');
  } catch {
    fileExists = false;
    content = '';
  }

  const raw = parseRaw(content);
  return { properties: mapToProperties(raw), fileExists };
}

export async function writeServerProperties(updates: BedrockServerProperties): Promise<void> {
  const filePath = propertiesFilePath();

  let original = '';
  try {
    original = await readFile(filePath, 'utf8');
  } catch {
    // file doesn't exist yet — will create from scratch
  }

  const merged = mergeIntoFile(original, updates);
  await writeFile(filePath, merged, 'utf8');
}
