import { Command } from "commander";
import { renderTemplate } from "@bb/templates";
import { outputJson } from "./helpers.js";

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description("Show the BB system overview and CLI guide")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      const systemOverview = renderTemplate("bbSystemOverview", {});
      const cliGuide = renderTemplate("bbCliGuide", {});

      if (outputJson(opts, { systemOverview, cliGuide })) return;

      console.log(systemOverview);
      console.log("---");
      console.log(cliGuide);
    });
}
