import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolveBridgePathArgs {
  importMetaUrl: string;
  bridgeRelativePath: string;
  bridgeBundleDir?: string;
  bundleFileName?: string;
}

export type BridgeProcessArgs = string[];

function resolveTsxLoaderSpecifier(): string {
  return import.meta.resolve("tsx");
}

function sourceTypeScriptCandidate(sourceJavaScriptPath: string): string {
  return sourceJavaScriptPath.replace(/\.js$/u, ".ts");
}

function sourceTypeScriptProcessArgs(sourcePath: string): BridgeProcessArgs {
  return [
    "--conditions=source",
    "--import",
    resolveTsxLoaderSpecifier(),
    sourcePath,
  ];
}

export function resolveBridgeProcessArgs(
  args: ResolveBridgePathArgs,
): BridgeProcessArgs {
  if (args.bridgeBundleDir && args.bundleFileName) {
    return [resolve(args.bridgeBundleDir, args.bundleFileName)];
  }

  const moduleDir = dirname(fileURLToPath(args.importMetaUrl));
  const sourceCandidate = resolve(moduleDir, args.bridgeRelativePath);
  if (existsSync(sourceCandidate)) {
    return [sourceCandidate];
  }

  const sourceTsCandidate = sourceTypeScriptCandidate(sourceCandidate);
  if (existsSync(sourceTsCandidate)) {
    return sourceTypeScriptProcessArgs(sourceTsCandidate);
  }

  throw new Error(
    `Missing provider bridge. Expected source bridge at ${sourceTsCandidate}` +
      (args.bridgeBundleDir && args.bundleFileName
        ? ` or bundled bridge at ${resolve(args.bridgeBundleDir, args.bundleFileName)}`
        : ""),
  );
}
