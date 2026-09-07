import { templateDefinitions, type TemplateId } from "@bb/templates/generated";

export interface GuideRenderArgs {
  chapter?: string;
}

export interface GuideRenderResult {
  chapter?: string;
  content: string;
}

export interface GuideArea {
  render(args?: GuideRenderArgs): GuideRenderResult;
}

const guideChapters: Record<string, TemplateId> = {
  threads: "bbGuideThreads",
  environments: "bbGuideEnvironments",
  "agent-configuration": "bbGuideAgentConfiguration",
  providers: "bbGuideProviders",
  projects: "bbGuideProjects",
  machines: "bbGuideMachines",
  terminals: "bbGuideTerminals",
  browser: "bbGuideBrowser",
  customization: "bbGuideCustomization",
  plugins: "bbGuidePlugins",
  automations: "bbGuideAutomations",
};

const templateBodyById = new Map(
  templateDefinitions.map((template) => [template.id, template.body]),
);

function renderStaticTemplate(templateId: TemplateId): string {
  const body = templateBodyById.get(templateId);
  if (body === undefined) {
    throw new Error(`Template '${templateId}' is unavailable.`);
  }
  return body;
}

export function createGuideArea(): GuideArea {
  return {
    render(input = {}) {
      if (!input.chapter) {
        return { content: renderStaticTemplate("bbGuideOverview") };
      }
      const templateId = guideChapters[input.chapter];
      if (!templateId) {
        const available = Object.keys(guideChapters).join(", ");
        throw new Error(
          `Unknown guide chapter '${input.chapter}'. Available: ${available}.`,
        );
      }
      return {
        chapter: input.chapter,
        content: renderStaticTemplate(templateId),
      };
    },
  };
}
