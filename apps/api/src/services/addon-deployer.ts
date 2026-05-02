export interface AddonDeployer {
  deployFromPath(path: string): Promise<{ ok: true; message: string }>;
}

export const addonDeployer: AddonDeployer = {
  async deployFromPath(path) {
    return {
      ok: true,
      message: `Deployment stub. Received path: ${path}`,
    };
  },
};
