import { toOptionalTrimmedString } from "@bb/config/strings";
import { hostTypeSchema } from "@bb/domain";
import type { HostType } from "@bb/domain";

export interface HostDaemonEntrypointOptions {
  bbExecutableDirectory?: string;
  bridgeBundleDir?: string;
  enrollKey?: string;
  hostType?: HostType;
}

export interface ResolveHostDaemonEntrypointOptionsFromEnvArgs {
  env: NodeJS.ProcessEnv;
}

function parseHostType(value: string | undefined): HostType | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = hostTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid BB_HOST_TYPE "${value}"`);
  }

  return parsed.data;
}

export function resolveHostDaemonEntrypointOptionsFromEnv(
  args: ResolveHostDaemonEntrypointOptionsFromEnvArgs,
): HostDaemonEntrypointOptions {
  return {
    bbExecutableDirectory: toOptionalTrimmedString(args.env.BB_CLI_DIR),
    bridgeBundleDir: toOptionalTrimmedString(args.env.BB_BRIDGE_DIR),
    enrollKey: toOptionalTrimmedString(args.env.BB_HOST_ENROLL_KEY),
    hostType: parseHostType(toOptionalTrimmedString(args.env.BB_HOST_TYPE)),
  };
}
