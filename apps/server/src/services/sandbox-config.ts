import type { PublicServerUrlConfig } from "./public-server-url.js";
import { hasConfiguredReachablePublicServerUrl } from "./public-server-url.js";

export interface SandboxTemplateConfig {
  e2bTemplate: string;
}

export interface SandboxProvisioningConfig
  extends SandboxTemplateConfig,
    PublicServerUrlConfig {
  e2bApiKey: string;
}

export function hasConfiguredSandboxTemplate(
  config: SandboxTemplateConfig,
): boolean {
  return config.e2bTemplate !== "";
}

export function isSandboxProvisioningConfigured(
  config: SandboxProvisioningConfig,
): boolean {
  return (
    config.e2bApiKey !== "" &&
    hasConfiguredSandboxTemplate(config) &&
    hasConfiguredReachablePublicServerUrl(config)
  );
}
