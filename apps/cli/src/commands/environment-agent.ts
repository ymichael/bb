import { spawn } from "node:child_process";
import { Command } from "commander";

interface EnvironmentAgentOptions {
  providerCommand: string;
  providerArg?: string[];
}

export function registerEnvironmentAgentCommand(program: Command): void {
  program
    .command("environment-agent")
    .description("Run the environment-agent relay process")
    .allowUnknownOption(false)
    .option(
      "--provider-command <command>",
      "Provider runtime command to launch inside the environment",
    )
    .option(
      "--provider-arg <arg>",
      "Provider runtime argument (repeatable)",
      collectRepeatableOption,
      [],
    )
    .action((opts: EnvironmentAgentOptions) => {
      const providerCommand = opts.providerCommand?.trim();
      if (!providerCommand) {
        console.error("Missing required --provider-command");
        process.exit(1);
        return;
      }

      const child = spawn(providerCommand, opts.providerArg ?? [], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      process.stdin.pipe(child.stdin!);
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);

      const forwardSignal = (signal: NodeJS.Signals) => {
        try {
          child.kill(signal);
        } catch {
          // Ignore shutdown races.
        }
      };

      process.on("SIGINT", () => forwardSignal("SIGINT"));
      process.on("SIGTERM", () => forwardSignal("SIGTERM"));

      child.once("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 1);
      });

      child.once("error", (error) => {
        console.error(error.message);
        process.exit(1);
      });
    });
}

function collectRepeatableOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
