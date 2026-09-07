import { Command } from "commander";
import { createGuideArea } from "@bb/sdk/node";
import { action } from "../action.js";
import { outputJson } from "./helpers.js";

interface GuideCommandOptions {
  json?: boolean;
}

export function registerGuideCommand(program: Command): void {
  program
    .command("guide [chapter]")
    .description("Show the BB system overview and CLI guide")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (chapter: string | undefined, opts: GuideCommandOptions) => {
        const rendered = createGuideArea().render({ chapter });
        if (chapter) {
          if (outputJson(opts, rendered)) return;
          console.log(rendered.content);
          return;
        }

        if (outputJson(opts, { overview: rendered.content })) return;
        console.log(rendered.content);
      }),
    );
}
