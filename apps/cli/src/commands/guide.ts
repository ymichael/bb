import { Command } from "commander";
import { renderTemplate } from "@bb/templates";
import type { TemplateId } from "@bb/templates";
import { action } from "../action.js";
import { outputJson } from "./helpers.js";

const guideChapters: Record<string, TemplateId> = {
  threads: "bbGuideThreads",
  environments: "bbGuideEnvironments",
  managers: "bbGuideManagers",
  providers: "bbGuideProviders",
  projects: "bbGuideProjects",
  hosts: "bbGuideHosts",
  styling: "bbGuideStyling",
  async: "bbGuideAsync",
};

export function registerGuideCommand(program: Command): void {
  program
    .command("guide [chapter]")
    .description("Show the BB system overview and CLI guide")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (chapter: string | undefined, opts: { json?: boolean }) => {
        if (chapter) {
          const templateId = guideChapters[chapter];
          if (!templateId) {
            const available = Object.keys(guideChapters).join(", ");
            throw new Error(
              `Unknown guide chapter '${chapter}'. Available: ${available}.`,
            );
          }
          const content = renderTemplate(templateId, {});
          if (outputJson(opts, { chapter, content })) return;
          console.log(content);
          return;
        }

        const overview = renderTemplate("bbGuideOverview", {});
        if (outputJson(opts, { overview })) return;
        console.log(overview);
      }),
    );
}
