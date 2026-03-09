import { Command } from "commander";
import {
  EnvironmentAgentRuntime,
  createEnvironmentAgentHttpServer,
} from "@beanbag/environment-agent";

interface EnvironmentAgentOptions {
  providerCommand?: string;
  providerArg?: string[];
  providerLaunchCommand?: string;
  providerLaunchArg?: string[];
  httpPort?: string;
  httpHost?: string;
}

const BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN = "BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN";
const BEANBAG_DAEMON_URL = "BEANBAG_DAEMON_URL";

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
      if (!opts.httpPort) {
        console.error("Missing required --http-port");
        process.exit(1);
        return;
      }

      const authToken = process.env[BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN]?.trim();
      if (!authToken) {
        console.error(`Missing required ${BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN}`);
        process.exit(1);
        return;
      }

      const providerCommand = opts.providerCommand?.trim();

      const runtime = new EnvironmentAgentRuntime({
        threadId: process.env.BB_THREAD_ID,
        projectId: process.env.BB_PROJECT_ID,
        environmentId: process.env.BB_ENVIRONMENT_ID,
        daemonConnection: {
          daemonUrl: process.env[BEANBAG_DAEMON_URL],
          authToken,
          threadId: process.env.BB_THREAD_ID,
          projectId: process.env.BB_PROJECT_ID,
          environmentId: process.env.BB_ENVIRONMENT_ID,
        },
        providerCommand,
        providerArgs: opts.providerArg ?? [],
        providerLaunchCommand: opts.providerLaunchCommand?.trim(),
        providerLaunchArgs: opts.providerLaunchArg ?? [],
      });
      runtime.start();

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
        bearerToken: authToken,
      });
      console.error(`environment-agent http listening on ${server.baseUrl}`);
      const shutdown = async () => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", () => {
        void shutdown();
      });
      process.on("SIGTERM", () => {
        void shutdown();
      });
    });
}

function collectRepeatableOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
