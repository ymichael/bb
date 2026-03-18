import { Command } from "commander";
import { resolveContextSnapshot } from "../context-env.js";
import { outputJson } from "./helpers.js";

export function registerStatusCommand(
  program: Command,
  _getUrl: () => string,
): void {
  program
    .command("status")
    .description("Show current context")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      const context = resolveContextSnapshot();
      if (outputJson(opts, { projectId: context.projectId ?? null, threadId: context.threadId ?? null })) return;
      if (context.projectId) {
        console.log(`Project: ${context.projectId}`);
      } else {
        console.log("Project: <unset>");
      }
      if (context.threadId) {
        console.log(`Thread: ${context.threadId}`);
      } else {
        console.log("Thread: <unset>");
      }
    });
}
