import { z } from "zod";
import {
  FILE_LIST_QUERY_MAX_LENGTH,
  getProjectPathValidationMessage,
  gitBranchNameSchema,
  normalizeProjectPathInput,
  projectExecutionDefaultsSchema,
  projectSchema,
  projectSourceCheckoutSchema,
  projectSourceSchema,
  promptHistoryEntrySchema,
  threadListEntrySchema,
} from "@bb/domain";
import {
  rejectMultipleWorkspaceSelectors,
  branchListQuerySchema,
  isCommaSeparatedIncludeQueryValue,
  pathListIncludeQueryValueSchema,
} from "./shared.js";

const localProjectPathRequestSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeProjectPathInput)
  .superRefine((path, ctx) => {
    const validationMessage = getProjectPathValidationMessage(path);
    if (!validationMessage) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: validationMessage,
    });
  });

const createLocalPathProjectSourceRequestSchema = z
  .object({
    hostId: z.string().min(1),
    type: z.literal("local_path"),
    path: localProjectPathRequestSchema,
  })
  .strict();

const cloneProjectSourceRequestSchema = z
  .object({
    hostId: z.string().min(1),
    type: z.literal("clone"),
    targetPath: localProjectPathRequestSchema.optional(),
    remoteUrl: z.string().trim().min(1).optional(),
  })
  .strict();

export const createProjectSourceRequestSchema = z.discriminatedUnion("type", [
  createLocalPathProjectSourceRequestSchema,
  cloneProjectSourceRequestSchema,
]);
export type CreateProjectSourceRequest = z.infer<
  typeof createProjectSourceRequestSchema
>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1),
  source: createLocalPathProjectSourceRequestSchema,
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const threadSectionSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type ThreadSectionResponse = z.infer<typeof threadSectionSchema>;

export const createThreadSectionRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();
export type CreateThreadSectionRequest = z.infer<
  typeof createThreadSectionRequestSchema
>;

export const updateThreadSectionRequestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type UpdateThreadSectionRequest = z.infer<
  typeof updateThreadSectionRequestSchema
>;

export const deleteThreadSectionRequestSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();
export type DeleteThreadSectionRequest = z.infer<
  typeof deleteThreadSectionRequestSchema
>;

export const threadSectionMutationResponseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    updatedThreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadSectionMutationResponse = z.infer<
  typeof threadSectionMutationResponseSchema
>;

export const reorderProjectRequestSchema = z.object({
  previousProjectId: z.string().min(1).nullable(),
  nextProjectId: z.string().min(1).nullable(),
});
export type ReorderProjectRequest = z.infer<typeof reorderProjectRequestSchema>;

export const projectListIncludeOptionSchema = z.enum(["threads"]);
export type ProjectListIncludeOption = z.infer<
  typeof projectListIncludeOptionSchema
>;

export const projectListQuerySchema = z.object({
  include: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: projectListIncludeOptionSchema.options,
          value,
        }),
      { message: "Invalid include" },
    )
    .optional(),
  includePersonal: z.enum(["true", "false"]).optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

const projectWorkspaceRoutingFields = {
  hostId: z.string().min(1),
  environmentId: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
} as const;

export const projectWorkspaceRoutingQuerySchema = z
  .object(projectWorkspaceRoutingFields)
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type ProjectWorkspaceRoutingQuery = z.infer<
  typeof projectWorkspaceRoutingQuerySchema
>;

export const projectFilesQuerySchema = z
  .object({
    ...projectWorkspaceRoutingFields,
    query: z.string().min(1).max(FILE_LIST_QUERY_MAX_LENGTH).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type ProjectFilesQuery = z.infer<typeof projectFilesQuerySchema>;

export const projectPathsQuerySchema = z
  .object({
    ...projectWorkspaceRoutingFields,
    query: z.string().min(1).max(FILE_LIST_QUERY_MAX_LENGTH).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    includeFiles: pathListIncludeQueryValueSchema,
    includeDirectories: pathListIncludeQueryValueSchema,
  })
  .partial({
    hostId: true,
    environmentId: true,
    query: true,
    limit: true,
  })
  .superRefine(rejectMultipleWorkspaceSelectors);
export type ProjectPathsQuery = z.infer<typeof projectPathsQuerySchema>;

export const projectFileContentQuerySchema = z
  .object({
    ...projectWorkspaceRoutingFields,
    path: z.string().min(1),
  })
  .partial({ hostId: true, environmentId: true })
  .superRefine(rejectMultipleWorkspaceSelectors);
export type ProjectFileContentQuery = z.infer<
  typeof projectFileContentQuerySchema
>;

export const projectBranchesQuerySchema = branchListQuerySchema
  .extend({
    hostId: z.string().min(1),
    selectedBranch: gitBranchNameSchema.optional(),
  })
  .strict();
export type ProjectBranchesQuery = z.infer<typeof projectBranchesQuerySchema>;

export const projectBranchesResponseSchema = projectSourceCheckoutSchema.extend(
  {
    defaultWorktreeBaseBranch: z.string().min(1).nullable(),
  },
);
export type ProjectBranchesResponse = z.infer<
  typeof projectBranchesResponseSchema
>;

export const projectAttachmentContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type ProjectAttachmentContentQuery = z.infer<
  typeof projectAttachmentContentQuerySchema
>;

export const projectDefaultExecutionOptionsQuerySchema = z.object({});
export type ProjectDefaultExecutionOptionsQuery = z.infer<
  typeof projectDefaultExecutionOptionsQuerySchema
>;

export const promptHistoryQuerySchema = z
  .object({
    limit: z.string().regex(/^\d+$/),
  })
  .partial();
export type PromptHistoryQuery = z.infer<typeof promptHistoryQuerySchema>;

export const promptHistoryResponseSchema = z.array(promptHistoryEntrySchema);
export type PromptHistoryResponse = z.infer<typeof promptHistoryResponseSchema>;

export type ProjectAttachmentUploadForm = Record<"file", Blob>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .partial()
  .refine(
    (value) => value.name !== undefined,
    "At least one field must be provided",
  );
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const updateProjectSourceRequestSchema = z
  .object({
    type: z.literal("local_path"),
    path: localProjectPathRequestSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => value.path !== undefined || value.isDefault !== undefined,
    "At least one field besides type must be provided",
  );
export type UpdateProjectSourceRequest = z.infer<
  typeof updateProjectSourceRequestSchema
>;

export const providerCommandSourceSchema = z.enum(["skill", "command"]);
export type ProviderCommandSource = z.infer<typeof providerCommandSourceSchema>;

export const providerCommandOriginSchema = z.enum([
  "builtin",
  "project",
  "user",
]);
export type ProviderCommandOrigin = z.infer<typeof providerCommandOriginSchema>;

export const providerCommandSchema = z.object({
  name: z.string(),
  source: providerCommandSourceSchema,
  origin: providerCommandOriginSchema,
  description: z.string().nullable(),
  argumentHint: z.string().nullable(),
  pluginId: z.string().min(1).optional(),
});
export type ProviderCommand = z.infer<typeof providerCommandSchema>;

export const PROVIDER_COMMAND_SECTIONS = [
  "agent-command",
  "skill",
  "project-command",
  "user-command",
] as const;
export type ProviderCommandSection = (typeof PROVIDER_COMMAND_SECTIONS)[number];

export function providerCommandSection(cmd: {
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
}): ProviderCommandSection {
  if (cmd.origin === "builtin") {
    return "agent-command";
  }
  if (cmd.source === "skill") {
    return "skill";
  }
  return cmd.origin === "project" ? "project-command" : "user-command";
}

export function providerCommandSectionRank(cmd: {
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
}): number {
  return PROVIDER_COMMAND_SECTIONS.indexOf(providerCommandSection(cmd));
}

export const commandListResponseSchema = z.object({
  commands: z.array(providerCommandSchema),
});
export type CommandListResponse = z.infer<typeof commandListResponseSchema>;

export const projectCommandsQuerySchema = z
  .object({
    ...projectWorkspaceRoutingFields,
    provider: z.string().min(1),
  })
  .partial({ hostId: true, environmentId: true })
  .strict()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type ProjectCommandsQuery = z.infer<typeof projectCommandsQuerySchema>;

export const skillScopeSchema = z.enum([
  "bb-builtin",
  "bb-user",
  "bb-project",
  "provider-user",
  "provider-project",
  "shared-user",
  "shared-project",
  "plugin",
]);
export type SkillScope = z.infer<typeof skillScopeSchema>;

export const skillProviderSchema = z.string().min(1);
export type SkillProvider = z.infer<typeof skillProviderSchema>;

export const installedSkillIdSchema = z.string().regex(/^skill_[a-f0-9]{64}$/u);

export const skillRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const skillSummarySchema = z.object({
  id: installedSkillIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  provider: skillProviderSchema.nullable(),
  scope: skillScopeSchema,
  pluginId: z.string().min(1).nullable(),
  filePath: z.string(),
  manageable: z.boolean(),
  registrySkillId: z.string().min(1).nullable(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillListResponseSchema = z.object({
  skills: z.array(skillSummarySchema),
});
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;

export const projectSkillsQuerySchema = z.object({
  environmentId: z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().min(1).nullable(),
  ),
});
export type ProjectSkillsQuery = z.infer<typeof projectSkillsQuerySchema>;

export const editableSkillScopeSchema = z.enum([
  "bb-user",
  "bb-project",
  "provider-user",
  "provider-project",
]);
export type EditableSkillScope = z.infer<typeof editableSkillScopeSchema>;

export const deletableSkillScopeSchema = editableSkillScopeSchema;
export type DeletableSkillScope = z.infer<typeof deletableSkillScopeSchema>;

export const deleteSkillRequestSchema = z
  .object({
    skillId: installedSkillIdSchema,
    environmentId: z.string().min(1).nullable(),
  })
  .strict();
export type DeleteSkillRequest = z.infer<typeof deleteSkillRequestSchema>;

export const projectSkillFilesQuerySchema = z.object({
  skillId: installedSkillIdSchema,
  environmentId: z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().min(1).nullable(),
  ),
});
export type ProjectSkillFilesQuery = z.infer<
  typeof projectSkillFilesQuerySchema
>;

export const projectSkillContentQuerySchema =
  projectSkillFilesQuerySchema.extend({
    path: z.string().min(1).max(4_096),
  });
export type ProjectSkillContentQuery = z.infer<
  typeof projectSkillContentQuerySchema
>;

export const skillContentResponseSchema = z.object({
  content: z.string(),
  revision: skillRevisionSchema,
});
export type SkillContentResponse = z.infer<typeof skillContentResponseSchema>;

export const skillFilesResponseSchema = z.object({
  files: z.array(z.string().min(1)),
  truncated: z.boolean(),
});
export type SkillFilesResponse = z.infer<typeof skillFilesResponseSchema>;

export const updateSkillRequestSchema = z
  .object({
    skillId: installedSkillIdSchema,
    environmentId: z.string().min(1).nullable(),
    content: z.string().min(1).max(1_000_000),
    revision: skillRevisionSchema,
  })
  .strict();
export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>;

export const projectResponseSchema = projectSchema.extend({
  sources: z.array(projectSourceSchema),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectWithThreadsResponseSchema = projectResponseSchema.extend({
  threads: z.array(threadListEntrySchema),
  defaultExecutionOptions: projectExecutionDefaultsSchema.nullable(),
});
export type ProjectWithThreadsResponse = z.infer<
  typeof projectWithThreadsResponseSchema
>;

export const sidebarBootstrapResponseSchema = z.object({
  sections: z.array(threadSectionSchema),
  projects: z.array(projectWithThreadsResponseSchema),
  personalProject: projectWithThreadsResponseSchema,
});
export type SidebarBootstrapResponse = z.infer<
  typeof sidebarBootstrapResponseSchema
>;

export const uploadedPromptAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});
export type UploadedPromptAttachment = z.infer<
  typeof uploadedPromptAttachmentSchema
>;

export const copyProjectAttachmentsRequestSchema = z
  .object({
    sourceProjectId: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();
export type CopyProjectAttachmentsRequest = z.infer<
  typeof copyProjectAttachmentsRequestSchema
>;
