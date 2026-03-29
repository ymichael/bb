export interface SandboxImageBuildRecord {
  buildId: string;
  builtAt: string;
  createTarget: string;
  dockerfileHash: string;
  name: string;
  tags: string[];
  templateId: string;
}

export interface SandboxImageTemplateRegistry {
  current: SandboxImageBuildRecord | null;
}
