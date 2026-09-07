import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CustomAcpAgent } from "./agents.js";

export const LEGACY_CUSTOM_AGENTS_REMOVED_IN = "0.41";

const legacyConfigSchema = z
  .object({ customAcpAgents: z.array(z.unknown()).optional() })
  .passthrough();

function withoutLegacyLogo(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return entry;
  }
  if (!Object.hasOwn(entry, "logo")) {
    return entry;
  }
  const { logo: _logo, ...rest } = entry as Record<string, unknown>;
  return rest;
}

export async function readLegacyCustomAcpAgents(
  dataDir: string,
): Promise<{ entries: unknown[]; problem?: string }> {
  const path = join(dataDir, "config.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { entries: [] }
      : { entries: [], problem: `could not read ${path}: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      entries: [],
      problem: `${path} is not valid JSON: ${String(error)}`,
    };
  }
  const config = legacyConfigSchema.safeParse(parsed);
  if (!config.success) {
    return { entries: [], problem: `${path} is not a bb config file` };
  }
  return {
    entries: (config.data.customAcpAgents ?? []).map(withoutLegacyLogo),
  };
}

export function legacyAgentDeprecationMessage(agent: CustomAcpAgent): string {
  return (
    `Custom ACP agent "${agent.id}" comes from the deprecated customAcpAgents ` +
    `array in config.json. bb reads it until ${LEGACY_CUSTOM_AGENTS_REMOVED_IN}; ` +
    `move it to the ACP providers plugin's "customAgents" setting.`
  );
}
