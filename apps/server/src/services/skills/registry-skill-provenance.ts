import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const REGISTRY_SKILL_PROVENANCE_FILE_NAME = ".bb-registry-skill.json";

const registrySkillProvenanceSchema = z
  .object({
    version: z.literal(1),
    registrySkillId: z.string().min(1),
  })
  .strict();

export async function writeRegistrySkillProvenance(args: {
  registrySkillId: string;
  skillDirectoryPath: string;
}): Promise<void> {
  const filePath = path.join(
    args.skillDirectoryPath,
    REGISTRY_SKILL_PROVENANCE_FILE_NAME,
  );
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ version: 1, registrySkillId: args.registrySkillId })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o444 },
  );
}

export function readRegistrySkillProvenance(
  skillDirectoryPath: string,
): string | null {
  try {
    const parsed = registrySkillProvenanceSchema.safeParse(
      JSON.parse(
        readFileSync(
          path.join(skillDirectoryPath, REGISTRY_SKILL_PROVENANCE_FILE_NAME),
          "utf8",
        ),
      ),
    );
    return parsed.success ? parsed.data.registrySkillId : null;
  } catch {
    return null;
  }
}
