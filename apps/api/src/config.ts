import { z } from 'zod';
import { resolve } from 'node:path';

const envSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().default('127.0.0.1'),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  BEDROCK_SERVER_DIR: z
    .string()
    .default(resolve(process.cwd(), '.runtime', 'bedrock')),
  BEDROCK_SERVER_EXE: z.string().default('bedrock_server.exe'),
  BEDROCK_DOWNLOAD_URL: z.string().trim().default(''),
  BEDROCK_STOP_COMMAND: z.string().default('stop'),
  BEDROCK_STOP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  return envSchema.parse(process.env);
}
