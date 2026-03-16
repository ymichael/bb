export type E2eProviderMode = "fake" | "real";

export function resolveE2eProviderMode(): E2eProviderMode {
  const rawMode = (process.env.BB_E2E_PROVIDER_MODE ?? process.env.BB_E2E_PROVIDER_MODE ?? "fake")
    .trim()
    .toLowerCase();

  switch (rawMode) {
    case "fake":
      return "fake";
    case "real":
      return "real";
    default:
      throw new Error(
        `Unsupported BB_E2E_PROVIDER_MODE "${rawMode}". Expected one of: fake, real.`,
      );
  }
}

export function e2eTimeoutMs(fakeMs: number, realMs: number): number {
  return resolveE2eProviderMode() === "fake" ? fakeMs : realMs;
}

export function supportsFakeCodexControl(): boolean {
  return resolveE2eProviderMode() === "fake";
}
