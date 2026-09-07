export const MAX_LIMIT_VALUE = 10_000;

export interface HostLimitOverride {
  readonly hostId: string;
  readonly limit: number;
}

export interface LimitConfiguration {
  readonly globalLimit: number | null;
  readonly hostOverrides: readonly HostLimitOverride[];
}

export interface ResolvedHostLimit {
  readonly limit: number;
  readonly mode: "automatic" | "override";
}

export function automaticHostLimit(
  availableParallelism: number | null,
): number {
  if (availableParallelism === null) return 1;
  return availableParallelism;
}

export function resolveHostLimit(
  configuration: LimitConfiguration,
  hostId: string,
  availableParallelism: number | null,
): ResolvedHostLimit {
  const override = configuration.hostOverrides.find(
    (candidate) => candidate.hostId === hostId,
  );
  return override === undefined
    ? {
        limit: automaticHostLimit(availableParallelism),
        mode: "automatic",
      }
    : { limit: override.limit, mode: "override" };
}
