import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ServerLifecycleState,
  ServerStatusResponse,
} from '@bedrock-panel/shared';

type ServerAction = 'start' | 'stop' | 'restart';

interface ProcessManagerConfig {
  bedrockServerDir: string;
  bedrockServerExe: string;
  bedrockStopCommand: string;
  bedrockStopTimeoutMs: number;
}

export interface LifecycleChangeEvent {
  previousState: ServerLifecycleState;
  state: ServerLifecycleState;
  at: string;
  reason: string;
}

let state: ServerLifecycleState = 'stopped';
let activeProcess: ReturnType<typeof spawn> | null = null;
let startedAt: number | null = null;
let currentConfig: ProcessManagerConfig | null = null;
let stopTimeout: NodeJS.Timeout | null = null;
const lifecycleListeners = new Set<(event: LifecycleChangeEvent) => void>();

const logListeners = new Set<(line: string) => void>();
const recentLogs: string[] = [];
const maxRecentLogs = 250;
let pendingStopResolver: ((message: string) => void) | null = null;

function emitLog(line: string) {
  recentLogs.push(line);
  if (recentLogs.length > maxRecentLogs) {
    recentLogs.shift();
  }

  for (const listener of logListeners) {
    listener(line);
  }
}

function setState(nextState: ServerLifecycleState, reason: string) {
  if (state === nextState) {
    return;
  }

  const previousState = state;
  state = nextState;
  const event: LifecycleChangeEvent = {
    previousState,
    state: nextState,
    at: new Date().toISOString(),
    reason,
  };

  for (const listener of lifecycleListeners) {
    listener(event);
  }
}

function clearStopTimeout() {
  if (stopTimeout) {
    clearTimeout(stopTimeout);
    stopTimeout = null;
  }
}

function resolveExecutablePath(config: ProcessManagerConfig): string {
  return isAbsolute(config.bedrockServerExe)
    ? config.bedrockServerExe
    : resolve(config.bedrockServerDir, config.bedrockServerExe);
}

function assertConfigured(): ProcessManagerConfig {
  if (!currentConfig) {
    throw new Error('Process manager is not configured.');
  }

  return currentConfig;
}

function startDataForwarder(streamName: 'stdout' | 'stderr', chunk: Buffer) {
  const text = chunk.toString('utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    emitLog(`[${streamName}] ${line}`);
  }
}

export function configureProcessManager(config: ProcessManagerConfig) {
  currentConfig = config;
}

export function subscribeServerLogs(listener: (line: string) => void): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

export function subscribeServerLifecycle(
  listener: (event: LifecycleChangeEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

export function getRecentServerLogs(): string[] {
  return [...recentLogs];
}

export function getServerStatus(): ServerStatusResponse {
  const now = Date.now();
  const uptimeMs = startedAt ? Math.max(0, now - startedAt) : 0;

  return {
    state,
    pid: activeProcess?.pid ?? null,
    uptimeMs,
    bedrockVersion: null,
  };
}

async function startServer(): Promise<string> {
  if (state === 'running' || state === 'starting') {
    return 'Server is already running or starting.';
  }

  const config = assertConfigured();
  const executablePath = resolveExecutablePath(config);
  if (!existsSync(executablePath)) {
    throw new Error(
      `Bedrock executable was not found at ${executablePath}. Set BEDROCK_SERVER_DIR and BEDROCK_SERVER_EXE.`,
    );
  }

  setState('starting', 'start requested');
  emitLog(`Starting Bedrock server from ${executablePath}`);

  const child = spawn(executablePath, [], {
    cwd: config.bedrockServerDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  activeProcess = child;

  child.stdout.on('data', (chunk: Buffer) => {
    startDataForwarder('stdout', chunk);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    startDataForwarder('stderr', chunk);
  });

  child.on('spawn', () => {
    startedAt = Date.now();
    setState('running', 'process spawned');
    emitLog(`Bedrock process started (pid ${child.pid ?? 'unknown'}).`);
  });

  child.on('error', (cause) => {
    clearStopTimeout();
    setState('crashed', `process error: ${cause.message}`);
    startedAt = null;
    activeProcess = null;
    emitLog(`Process error: ${cause.message}`);
    if (pendingStopResolver) {
      pendingStopResolver('Server stopped with process error.');
      pendingStopResolver = null;
    }
  });

  child.on('close', (code, signal) => {
    const wasStopping = state === 'stopping';

    clearStopTimeout();
    activeProcess = null;
    startedAt = null;

    if (wasStopping) {
      setState('stopped', 'graceful stop complete');
      emitLog(`Bedrock process stopped (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
      if (pendingStopResolver) {
        pendingStopResolver('Server stopped.');
        pendingStopResolver = null;
      }
      return;
    }

    setState('crashed', `unexpected exit code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    emitLog(`Bedrock process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
  });

  return 'Server start requested.';
}

async function stopServer(): Promise<string> {
  if (!activeProcess || !activeProcess.pid || state === 'stopped') {
    setState('stopped', 'already stopped');
    startedAt = null;
    return 'Server is already stopped.';
  }

  if (state === 'stopping') {
    return 'Stop is already in progress.';
  }

  const config = assertConfigured();
  setState('stopping', 'stop requested');
  emitLog('Stopping Bedrock server...');

  const processToStop = activeProcess;

  if (processToStop.stdin && processToStop.stdin.writable) {
    processToStop.stdin.write(`${config.bedrockStopCommand}\n`);
  }

  return new Promise((resolveStop) => {
    pendingStopResolver = resolveStop;
    clearStopTimeout();
    stopTimeout = setTimeout(() => {
      if (activeProcess && !activeProcess.killed) {
        emitLog('Graceful stop timed out. Forcing process termination.');
        activeProcess.kill();
      }
    }, config.bedrockStopTimeoutMs);
  });
}

export async function requestServerAction(action: ServerAction): Promise<string> {
  if (action === 'start') {
    return startServer();
  }

  if (action === 'stop') {
    return stopServer();
  }

  const stopMessage = await stopServer();
  const startMessage = await startServer();
  return `${stopMessage} ${startMessage}`.trim();
}

export async function shutdownProcessManager(): Promise<void> {
  if (activeProcess && state !== 'stopped') {
    await stopServer();
  }
}
