import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolveSandboxImageTemplateRegistryPath } from "./paths.js";
import type {
  SandboxImageBuildRecord,
  SandboxImageTemplateRegistry,
} from "./types.js";

const sandboxImageBuildRecordSchema = z.object({
  buildId: z.string(),
  builtAt: z.string(),
  createTarget: z.string(),
  dockerfileHash: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  templateId: z.string(),
});

const sandboxImageTemplateRegistrySchema = z.object({
  current: sandboxImageBuildRecordSchema.nullable(),
});

function fallbackTemplateRegistry(): SandboxImageTemplateRegistry {
  return { current: null };
}

export function readSandboxImageTemplateRegistry(): SandboxImageTemplateRegistry {
  try {
    const contents = readFileSync(
      resolveSandboxImageTemplateRegistryPath(),
      "utf8",
    );
    const parsed = sandboxImageTemplateRegistrySchema.safeParse(
      JSON.parse(contents),
    );
    return parsed.success ? parsed.data : fallbackTemplateRegistry();
  } catch {
    return fallbackTemplateRegistry();
  }
}

export function getCurrentSandboxImageBuild(): SandboxImageBuildRecord | null {
  return readSandboxImageTemplateRegistry().current;
}

export function resolveSandboxImageTemplate(): string {
  const currentBuild = getCurrentSandboxImageBuild();
  if (currentBuild) {
    return currentBuild.createTarget;
  }

  throw new Error(
    "No sandbox image build is recorded in packages/sandbox-image/templates.json. Run `pnpm exec turbo run template:build --filter=@bb/sandbox-image` or set E2B_TEMPLATE explicitly.",
  );
}
