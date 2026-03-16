import { Command } from "commander";
import {
  resolveEnvironmentAgentServiceOptions,
  startEnvironmentAgentService,
} from "@bb/environment-daemon";

interface EnvironmentAgentOptions {
  providerCommand?: string;
  providerArg?: string[];
  providerLaunchCommand?: string;
  providerLaunchArg?: string[];
  httpPort?: string;
  httpHost?: string;
}

export function registerEnvironmentAgentCommand(program: Command): void {
  program
    .command("environment-agent")
    .description("Run the environment-agent HTTP service")
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
      try {
        const options = resolveEnvironmentAgentServiceOptions({
          cli: {
            providerCommand: opts.providerCommand,
            providerArgs: opts.providerArg ?? [],
            providerLaunchCommand: opts.providerLaunchCommand,
            providerLaunchArgs: opts.providerLaunchArg ?? [],
            httpPort: opts.httpPort,
            httpHost: opts.httpHost,
          },
          env: process.env,
        });
        const { server, close } = await startEnvironmentAgentService(options);
        console.error(`environment-agent http listening on ${server.baseUrl}`);
        const shutdown = async () => {
          await close();
          process.exit(0);
        };
        process.on("SIGINT", () => {
          void shutdown();
        });
        process.on("SIGTERM", () => {
          void shutdown();
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

function collectRepeatableOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
