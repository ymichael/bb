import { assertNever } from "@beanbag/agent-core";

export type E2eProviderMode = "fake" | "real" | "real-claude-code" | "real-pi";

export function resolveE2eProviderMode(): E2eProviderMode {
  const rawMode = (process.env.BEANBAG_E2E_PROVIDER_MODE ?? "fake")
    .trim()
    .toLowerCase();

  switch (rawMode) {
    case "fake":
      return "fake";
    case "real":
      return "real";
    case "real-claude-code":
      return "real-claude-code";
    case "real-pi":
      return "real-pi";
    default:
      throw new Error(
        `Unsupported BEANBAG_E2E_PROVIDER_MODE "${rawMode}". Expected one of: fake, real, real-claude-code, real-pi.`,
      );
  }
}

export function e2eTimeoutMs(fakeMs: number, realMs: number): number {
  const providerMode = resolveE2eProviderMode();
  switch (providerMode) {
    case "fake":
      return fakeMs;
    case "real":
    case "real-claude-code":
    case "real-pi":
      return realMs;
    default:
      return assertNever(providerMode);
  }
}

export function supportsFakeCodexControl(): boolean {
  return resolveE2eProviderMode() === "fake";
}

export function supportsClaudeCodeProvider(): boolean {
  return resolveE2eProviderMode() === "real-claude-code";
}

export function supportsPiProvider(): boolean {
  return resolveE2eProviderMode() === "real-pi";
}
