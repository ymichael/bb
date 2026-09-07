import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type BridgeProcessArgs = string[];

const BRIDGE_WORKER_BUNDLE_FILE_NAME = "bb-provider-bridge-worker.mjs";

function sourceTypeScriptProcessArgs(sourcePath: string): BridgeProcessArgs {
  return [
    "--conditions=source",
    "--import",
    import.meta.resolve("tsx"),
    sourcePath,
  ];
}

export function resolveBridgeWorkerProcessArgs(args: {
  bridgeBundleDir?: string;
}): BridgeProcessArgs {
  if (args.bridgeBundleDir) {
    return [resolve(args.bridgeBundleDir, BRIDGE_WORKER_BUNDLE_FILE_NAME)];
  }
  const sourceEntry = fileURLToPath(
    import.meta.resolve("@bb/provider-bridge-protocol/bridge-worker-entry"),
  );
  return sourceEntry.endsWith(".ts")
    ? sourceTypeScriptProcessArgs(sourceEntry)
    : [sourceEntry];
}
