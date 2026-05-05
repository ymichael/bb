import { z } from "zod";
import {
  gitSnapshotSchema,
  replayCaptureManifestSchema,
} from "@bb/replay-capture/schema";

export const fixtureManifestSchema = replayCaptureManifestSchema
  .extend({
    source: z.literal("corpus-fixture"),
    corpusId: z.string().min(1),
    scenarioId: z.string().min(1),
    scenarioDescription: z.string().min(1),
    model: z.string().nullable(),
    gitSha: z.string().nullable(),
    gitResetRef: z.string().nullable(),
    workspacePath: z.string(),
    runtimeWorkspacePath: z.string(),
    envWorkspacePath: z.string(),
    runtimeWorkspaceGitStart: gitSnapshotSchema.nullable(),
    runtimeWorkspaceGitEnd: gitSnapshotSchema.nullable(),
  })
  .strict();
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;
