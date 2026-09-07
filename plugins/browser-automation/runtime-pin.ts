import {
  currentPlatform,
  installRuntime,
  type InstallOptions,
  type RuntimeRelease,
} from "./installer.js";

export const runtimeRelease: RuntimeRelease = {
  package: "dev-browser",
  version: "1.0.0-rc.3",
  registry: "https://registry.npmjs.org",
  repository: "SawyerHood/dev-browser",
  artifacts: {
    "linux-x64":
      "390dd08f8321807bca2e1e060ec031511adb0af002e871dfde3b1f6c8feac914",
    "linux-arm64":
      "8a1d7c80c3bede69809996848526b5ed43cf6f0965d87f99e4349b775f76042e",
    "darwin-x64":
      "76f70f6e8a48c5caf546003e09d9daa4a0cb756d191c4f7fc3c300c2e2935522",
    "darwin-arm64":
      "d68887f7df149915811bf362b208377c2d0d7d500297d4d5977dab129db5b5eb",
  },
};

export interface ResolvedRuntime {
  readonly binary: string;
  readonly version: string;
  readonly source: "release" | "developer-artifact";
}

export async function resolveRuntime(args: {
  dataDir: string;
  signal: AbortSignal;
  release?: RuntimeRelease;
  env?: NodeJS.ProcessEnv;
  onProgress?: InstallOptions["onProgress"];
}): Promise<ResolvedRuntime> {
  const release = args.release ?? runtimeRelease;
  const platform = currentPlatform();
  if (platform === null)
    throw new Error(
      `DevBrowser has no runtime for ${process.platform}-${process.arch}; choose a Linux or macOS browser host.`,
    );
  const installed = await installRuntime({
    release,
    dataDir: args.dataDir,
    platform,
    signal: args.signal,
    ...(args.env === undefined ? {} : { env: args.env }),
    ...(args.onProgress === undefined ? {} : { onProgress: args.onProgress }),
  });
  return {
    binary: installed.binary,
    version: release.version,
    source: "release",
  };
}
