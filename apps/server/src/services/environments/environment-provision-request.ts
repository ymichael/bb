import type { EnvironmentProvisionCommand } from "@bb/host-daemon-contract";

export interface EnvironmentProvisionRequest {
  command: EnvironmentProvisionCommand;
  mergeBaseBranch: string | null;
  mode: "provision" | "inspect";
}
