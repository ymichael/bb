import { Command } from "commander";
import {
  resolveEnvironmentDaemonServiceOptions,
  startEnvironmentDaemonService,
} from "@bb/environment-daemon";

interface EnvironmentDaemonOptions {
  providerCommand?: string;
  providerArg?: string[];
  providerLaunchCommand?: string;
  providerLaunchArg?: string[];
  httpPort?: string;
  httpHost?: string;
}

export function registerEnvironmentDaemonCommand(program: Command): void {
  program
    .command("environment-daemon")
    .description("Run the environment-daemon HTTP service")
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
    .option("--http-port <port>", "Run as an HTTP environment-daemon on the given port")
    .option("--http-host <host>", "HTTP bind host for environment-daemon", "127.0.0.1")
    .action(async (opts: EnvironmentDaemonOptions) => {
      try {
        const options = resolveEnvironmentDaemonServiceOptions({
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
        const { server, close } = await startEnvironmentDaemonService(options);
        console.error(`environment-daemon http listening on ${server.baseUrl}`);
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
