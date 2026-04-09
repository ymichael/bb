import type { SandboxEnvVar } from "@bb/server-contract";

export interface DeleteSandboxEnvVarArgs {
  name: string;
}

export interface UpsertSandboxEnvVarArgs {
  name: string;
  value: string;
}

export interface SandboxEnvService {
  deleteEnvVar(args: DeleteSandboxEnvVarArgs): Promise<boolean>;
  listEnvVars(): Promise<SandboxEnvVar[]>;
  resolveRuntimeEnv(): Promise<Record<string, string>>;
  upsertEnvVar(args: UpsertSandboxEnvVarArgs): Promise<SandboxEnvVar>;
}
