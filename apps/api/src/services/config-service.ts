export interface ConfigService {
  readServerConfig(): Promise<Record<string, string>>;
  writeServerConfig(values: Record<string, string>): Promise<void>;
}

export const configService: ConfigService = {
  async readServerConfig() {
    return {};
  },
  async writeServerConfig(_values) {
    return;
  },
};
