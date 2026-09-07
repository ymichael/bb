import {
  ResourceCreateButton,
  type ResourceCreateMenuAction,
  type ResourceCreateTemplateGroup,
} from "@bb/shared-ui/resource-list";
import type { IconName } from "@bb/shared-ui/icon";
import {
  BROWSE_ARCHETYPES,
  UTILITY_EXAMPLES,
  archetypePrompt,
  utilityPrompt,
} from "@/components/plugin/browse-hero/browse-hero-archetypes";
import { CREATE_PLUGIN_PROMPT, CREATE_SKILL_PROMPT } from "@bb/client-core";

type CreateViaPromptKind = "skill" | "plugin";

interface Example {
  label: string;
  icon: IconName;
  description: string;
  prompt?: string;
}

interface KindConfig {
  prefix: string;
  examples: readonly Example[];
}

const CONFIG: Record<CreateViaPromptKind, KindConfig> = {
  skill: {
    prefix: CREATE_SKILL_PROMPT,
    examples: [
      {
        label: "PR review",
        icon: "GitPullRequest",
        description:
          "reviews a GitHub PR, checks changed files, runs focused tests, and returns blocking findings first",
      },
      {
        label: "Release notes",
        icon: "FileText",
        description:
          "turns merged PRs into concise customer-facing release notes with links and risk notes",
      },
      {
        label: "Incident debug",
        icon: "Bug",
        description:
          "collects logs, recent deploys, and failing checks before proposing the smallest fix",
      },
    ],
  },
  plugin: {
    prefix: CREATE_PLUGIN_PROMPT,
    examples: BROWSE_ARCHETYPES.map((archetype) => ({
      label: archetype.title,
      icon: archetype.icon,
      description: archetype.hook,
      prompt: archetypePrompt(archetype),
    })),
  },
};

interface CreateExample {
  label: string;
  icon: IconName;
  description: string;
  prompt: string;
}

export function getCreateExamples(kind: CreateViaPromptKind): {
  examples: CreateExample[];
} {
  const config = CONFIG[kind];
  return {
    examples: config.examples.map((example) => ({
      label: example.label,
      icon: example.icon,
      description: example.description,
      prompt: example.prompt ?? `${config.prefix}${example.description}.`,
    })),
  };
}

interface CreateWithTemplatesButtonProps {
  kind: CreateViaPromptKind;
  label: string;
  menuActions?: readonly ResourceCreateMenuAction[];
  onCreate: (prompt?: string) => void;
}

export function CreateWithTemplatesButton({
  kind,
  label,
  menuActions,
  onCreate,
}: CreateWithTemplatesButtonProps) {
  const { examples } = getCreateExamples(kind);
  const templateGroups: readonly ResourceCreateTemplateGroup[] | undefined =
    kind === "plugin"
      ? [
          { label: "Examples", templates: examples },
          {
            label: "Capabilities",
            templates: UTILITY_EXAMPLES.map((example) => ({
              label: example.label,
              icon: example.icon,
              description: example.brief,
              prompt: utilityPrompt(example),
            })),
          },
        ]
      : undefined;
  return (
    <ResourceCreateButton
      label={label}
      templates={examples}
      templateGroups={templateGroups}
      menuActions={menuActions}
      onCreate={onCreate}
    />
  );
}
