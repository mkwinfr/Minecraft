export type ServerLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
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
export interface ApiErrorResponse {
    error: string;
    details?: string;
}
export interface LogEvent {
    kind: 'log';
    at: string;
    line: string;
}
