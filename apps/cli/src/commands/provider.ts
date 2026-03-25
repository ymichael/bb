import { Command } from "commander";
import type { AvailableModel } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import { action } from "../action.js";
import { createClient, unwrap } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

interface ProviderListCommandOptions {
  json?: boolean;
}

interface ProviderModelsCommandOptions {
  json?: boolean;
}

export function registerProviderCommands(program: Command, getUrl: () => string): void {
  const provider = program.command("provider").description("Inspect available providers and models");

  provider
    .command("list")
    .description("List available providers")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (opts: ProviderListCommandOptions) => {
      const client = createClient(getUrl());
      const providers = await unwrap<SystemProviderInfo[]>(
        client.api.v1.system.providers.$get({ query: {} }),
      );
      if (outputJson(opts, providers)) return;
      if (providers.length === 0) {
        console.log("No providers available");
        return;
      }
      printProviderTable(providers);
    }));

  provider
    .command("models [providerId]")
    .description("List available models for a provider")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      providerId: string | undefined,
      opts: ProviderModelsCommandOptions,
    ) => {
      const client = createClient(getUrl());
      const models = await unwrap<AvailableModel[]>(
        client.api.v1.system.models.$get({
          query: providerId ? { providerId } : {},
        }),
      );
      if (outputJson(opts, models)) return;
      if (models.length === 0) {
        console.log("No models available");
        return;
      }
      printModelTable(models, providerId);
    }));
}

function printProviderTable(providers: SystemProviderInfo[]): void {
  const rows = providers.map((provider) => [provider.id, provider.displayName]);
  const idWidth = Math.max(4, ...rows.map((row) => row[0].length));
  const nameWidth = Math.max(4, ...rows.map((row) => row[1].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Name"],
      colWidths: [idWidth, nameWidth],
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}

function printModelTable(models: AvailableModel[], providerId?: string): void {
  if (providerId) {
    console.log(`Models for ${providerId}:`);
  }

  const rows = models.map((model) => [
    model.model,
    model.displayName ?? model.model,
    model.isDefault ? "*" : "",
  ]);
  const modelWidth = Math.max(5, ...rows.map((row) => row[0].length));
  const nameWidth = Math.max(4, ...rows.map((row) => row[1].length));
  const defaultWidth = Math.max(7, ...rows.map((row) => row[2].length));
  const table = renderBorderlessTable(
    {
      head: ["Model", "Name", "Default"],
      colWidths: [modelWidth, nameWidth, defaultWidth],
      trimTrailingWhitespace: true,
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}
