import { Command } from "commander";
import type { AvailableModel, SystemProviderInfo } from "@bb/core";
import { createClient, unwrap } from "../client.js";
import { getErrorMessage, outputJson } from "./helpers.js";

export function registerProviderCommands(program: Command, getUrl: () => string): void {
  const provider = program.command("provider").description("Inspect available providers and models");

  provider
    .command("list")
    .description("List available providers")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const providers = await unwrap<SystemProviderInfo[]>(
          client.api.v1.system.providers.$get({ query: {} }),
        );
        if (outputJson(opts, providers)) return;
        if (providers.length === 0) {
          console.log("No providers available");
          return;
        }
        printProviderTable(providers);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  provider
    .command("models [providerId]")
    .description("List available models for a provider")
    .option("--json", "Print machine-readable JSON output")
    .action(async (providerId: string | undefined, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
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
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

function printProviderTable(providers: SystemProviderInfo[]): void {
  const idWidth = Math.max(4, ...providers.map((p) => p.id.length));
  const nameWidth = Math.max(4, ...providers.map((p) => p.displayName.length));

  const header = [
    "ID".padEnd(idWidth),
    "Name".padEnd(nameWidth),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const provider of providers) {
    console.log(
      [
        provider.id.padEnd(idWidth),
        provider.displayName.padEnd(nameWidth),
      ].join("  "),
    );
  }
  console.log("");
}

function printModelTable(models: AvailableModel[], providerId?: string): void {
  if (providerId) {
    console.log(`Models for ${providerId}:`);
  }

  const modelWidth = Math.max(5, ...models.map((m) => m.model.length));
  const nameWidth = Math.max(4, ...models.map((m) => (m.displayName ?? m.model).length));

  const header = [
    "Model".padEnd(modelWidth),
    "Name".padEnd(nameWidth),
    "Default",
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const model of models) {
    console.log(
      [
        model.model.padEnd(modelWidth),
        (model.displayName ?? model.model).padEnd(nameWidth),
        model.isDefault ? "*" : "",
      ].join("  "),
    );
  }
  console.log("");
}
