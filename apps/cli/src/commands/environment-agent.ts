import { Command } from "commander";
import {
  EnvironmentAgentRuntime,
  createEnvironmentAgentHttpServer,
} from "@beanbag/environment-agent";

interface EnvironmentAgentOptions {
  providerCommand: string;
  providerArg?: string[];
  providerLaunchCommand?: string;
  providerLaunchArg?: string[];
  httpPort?: string;
  httpHost?: string;
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
    .option(
      "--provider-launch-command <command>",
      "Optional command wrapper used to launch the provider runtime",
    )
    .option(
      "--provider-launch-arg <arg>",
      "Optional provider launcher argument (repeatable)",
      collectRepeatableOption,
      [],
    )
    .option("--http-port <port>", "Run as an HTTP environment-agent on the given port")
    .option("--http-host <host>", "HTTP bind host for environment-agent", "127.0.0.1")
    .action(async (opts: EnvironmentAgentOptions) => {
      const providerCommand = opts.providerCommand?.trim();
      if (!providerCommand) {
        console.error("Missing required --provider-command");
        process.exit(1);
        return;
      }

      const runtime = new EnvironmentAgentRuntime({
        threadId: process.env.BB_THREAD_ID,
        projectId: process.env.BB_PROJECT_ID,
        environmentId: process.env.BB_ENVIRONMENT_ID,
        providerCommand,
        providerArgs: opts.providerArg ?? [],
        providerLaunchCommand: opts.providerLaunchCommand?.trim(),
        providerLaunchArgs: opts.providerLaunchArg ?? [],
        attachProcessStdio: !opts.httpPort,
      });
      const child = runtime.start();

      if (opts.httpPort) {
        const httpPort = Number.parseInt(opts.httpPort, 10);
        if (!Number.isFinite(httpPort) || httpPort < 0) {
          console.error("Invalid --http-port");
          process.exit(1);
          return;
        }
        const server = await createEnvironmentAgentHttpServer({
          runtime,
          host: opts.httpHost?.trim() || "127.0.0.1",
          port: httpPort,
        });
        console.error(`environment-agent http listening on ${server.baseUrl}`);
      }

      const forwardSignal = (signal: NodeJS.Signals) => {
        try {
          child.kill(signal);
        } catch {
          // Ignore shutdown races.
        }
      };

      process.on("SIGINT", () => forwardSignal("SIGINT"));
      process.on("SIGTERM", () => forwardSignal("SIGTERM"));

      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 1);
      });

      child.once("error", (error: Error) => {
        console.error(error.message);
        process.exit(1);
      });
    });
}

function collectRepeatableOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
