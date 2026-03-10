#!/usr/bin/env node

import {
  resolveEnvironmentAgentServiceOptions,
  startEnvironmentAgentService,
} from "../service.js";

interface ParsedArgs {
  providerCommand?: string;
  providerArgs: string[];
  providerLaunchCommand?: string;
  providerLaunchArgs: string[];
  httpPort?: string;
  httpHost?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    providerArgs: [],
    providerLaunchArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--provider-command":
        parsed.providerCommand = argv[++index];
        break;
      case "--provider-arg":
        parsed.providerArgs.push(argv[++index] ?? "");
        break;
      case "--provider-launch-command":
        parsed.providerLaunchCommand = argv[++index];
        break;
      case "--provider-launch-arg":
        parsed.providerLaunchArgs.push(argv[++index] ?? "");
        break;
      case "--http-port":
        parsed.httpPort = argv[++index];
        break;
      case "--http-host":
        parsed.httpHost = argv[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  try {
    const options = resolveEnvironmentAgentServiceOptions({
      cli: parseArgs(process.argv.slice(2)),
      env: process.env,
    });
    const { runtime, server } = await startEnvironmentAgentService(options);
    console.error(
      `environment-agent http listening on ${server.baseUrl} (log: ${options.logging.filePath})`,
    );

    const shutdown = async () => {
      await runtime.shutdown();
      await server.close();
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
}

void main();
