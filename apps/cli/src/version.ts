import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const BB_APP_VERSION_FALLBACK = "0.0.0-dev";
const PARENT_LOOKUP_MAX_DEPTH = 8;

const bbAppPackageJsonSchema = z
  .object({
    name: z.string(),
    version: z.string().min(1),
  })
  .passthrough();

interface ResolveBbAppVersionArgs {
  env: NodeJS.ProcessEnv;
  fromDir: string;
}

function readBbAppVersionAt(packageJsonPath: string): string | null {
  try {
    const result = bbAppPackageJsonSchema.safeParse(
      JSON.parse(readFileSync(packageJsonPath, "utf8")),
    );
    if (!result.success || result.data.name !== "bb-app") {
      return null;
    }
    return result.data.version;
  } catch {
    return null;
  }
}

function trimEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveBbAppVersion(args: ResolveBbAppVersionArgs): string {
  const envValue = trimEnvValue(args.env.BB_APP_VERSION);
  if (envValue !== undefined) {
    return envValue;
  }

  let currentDir = resolve(args.fromDir);
  for (let depth = 0; depth < PARENT_LOOKUP_MAX_DEPTH; depth += 1) {
    const candidatePath = join(currentDir, "package.json");
    const candidateVersion = readBbAppVersionAt(candidatePath);
    if (candidateVersion !== null) {
      return candidateVersion;
    }
    const workspaceCandidatePath = join(
      currentDir,
      "packages",
      "bb-app",
      "package.json",
    );
    const workspaceCandidateVersion = readBbAppVersionAt(workspaceCandidatePath);
    if (workspaceCandidateVersion !== null) {
      return workspaceCandidateVersion;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return BB_APP_VERSION_FALLBACK;
}

export function resolveBbCliVersion(): string {
  return resolveBbAppVersion({
    env: process.env,
    fromDir: dirname(fileURLToPath(import.meta.url)),
  });
}
