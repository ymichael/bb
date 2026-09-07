import { Command } from "commander";
import {
  appCommandIdSchema,
  appShortcutSchema,
  appSettingsSchema,
  experimentKeySchema,
  experimentsSchema,
  type AppSettings,
  type AppShortcut,
  type Experiments,
} from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson } from "./helpers.js";
import { resolveMachineHostId, resolveMachineTargetOption } from "./machine.js";

interface JsonOptions {
  json?: boolean;
}

interface UsageOptions extends JsonOptions {
  host?: string;
  machine?: string;
}

function parseBoolean(value: string): boolean {
  if (value === "true" || value === "on") return true;
  if (value === "false" || value === "off") return false;
  throw new Error("value must be true, false, on, or off.");
}

function parseShortcut(value: string): AppShortcut {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (key === undefined) throw new Error("shortcut must include a key.");
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  for (const modifier of modifiers) {
    if (
      !["mod", "meta", "control", "ctrl", "alt", "shift"].includes(modifier)
    ) {
      throw new Error(`Unknown shortcut modifier '${modifier}'.`);
    }
  }
  return appShortcutSchema.parse({
    key,
    mod: modifiers.has("mod"),
    meta: modifiers.has("meta"),
    control: modifiers.has("control") || modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
  });
}

function generalSettingValueCandidates(value: string): unknown[] {
  if (value === "on") return [true, value];
  if (value === "off") return [false, value];
  try {
    return [JSON.parse(value), value];
  } catch {
    return [value];
  }
}

function updateGeneralSetting(
  settings: AppSettings,
  key: string,
  value: string,
): AppSettings {
  const settingKey = appSettingsSchema.keyof().safeParse(key);
  if (!settingKey.success) {
    throw new Error(
      `Unknown general setting '${key}'. Known settings: ${appSettingsSchema
        .keyof()
        .options.join(", ")}.`,
    );
  }

  for (const candidate of generalSettingValueCandidates(value)) {
    const updated = appSettingsSchema.safeParse({
      ...settings,
      [settingKey.data]: candidate,
    });
    if (updated.success) return updated.data;
  }

  throw new Error(
    `Invalid value '${value}' for '${settingKey.data}'. Booleans take true, false, on, or off, null clears a nullable setting, and structured values take JSON.`,
  );
}

function updateExperiment(
  experiments: Experiments,
  key: string,
  value: string,
): Experiments {
  const enabled = parseBoolean(value);
  const experimentKey = experimentKeySchema.safeParse(key);
  if (!experimentKey.success) {
    throw new Error(`Unknown experiment '${key}'.`);
  }
  return experimentsSchema.parse({
    ...experiments,
    [experimentKey.data]: enabled,
  });
}

export function registerSettingsCommands(
  program: Command,
  getUrl: () => string,
): void {
  const settings = program
    .command("settings")
    .description("Inspect and update BB settings");

  settings
    .command("show")
    .description("Show server-backed settings and feature state")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const result = await createCliBbSdk(getUrl()).system.config();
        if (outputJson(opts, result)) return;
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  settings
    .command("ai-services")
    .description(
      "Show the AI-service settings (BB_INFERENCE, BB_INFERENCE_FALLBACK, BB_TRANSCRIPTION) and the plugin services they may name",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const { aiServices } = await createCliBbSdk(getUrl()).system.config();
        if (outputJson(opts, aiServices)) return;
        console.log(`BB_INFERENCE          ${aiServices.inference}`);
        console.log(`BB_INFERENCE_FALLBACK ${aiServices.inferenceFallback}`);
        console.log(`BB_TRANSCRIPTION      ${aiServices.transcription}`);
        console.log("");
        if (aiServices.services.length === 0) {
          console.log("No plugin registers an AI service.");
          return;
        }
        console.log(
          "Registered services (<id>/<model> in the settings above):",
        );
        for (const service of aiServices.services) {
          console.log(
            `  ${service.id}  ${service.displayName}  [${service.kinds.join(", ")}]  plugin ${service.pluginId}`,
          );
        }
      }),
    );

  settings
    .command("general <key> <value>")
    .description("Set a Settings → General preference")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (key: string, value: string, opts: JsonOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const config = await sdk.system.config();
        const result = await sdk.system.updateGeneralSettings(
          updateGeneralSetting(config.generalSettings, key, value),
        );
        if (outputJson(opts, result)) return;
        console.log(`${key} updated`);
      }),
    );

  settings
    .command("experiment <key> <value>")
    .description("Set an experiment value")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (key: string, value: string, opts: JsonOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const config = await sdk.system.config();
        const result = await sdk.system.updateExperiments(
          updateExperiment(config.experiments, key, value),
        );
        if (outputJson(opts, result)) return;
        console.log(`${key} updated`);
      }),
    );

  const keyboard = settings
    .command("keyboard")
    .description("Manage keyboard settings and shortcut overrides");
  keyboard
    .command("hints <value>")
    .description("Show or hide held-modifier shortcut hints")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (value: string, opts: JsonOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const config = await sdk.system.config();
        const result = await sdk.system.updateGeneralSettings(
          updateGeneralSetting(
            config.generalSettings,
            "showKeyboardHints",
            value,
          ),
        );
        if (outputJson(opts, result)) return;
        console.log("Keyboard hint visibility updated");
      }),
    );
  keyboard
    .command("list")
    .description("List effective keybindings and overrides")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const config = await createCliBbSdk(getUrl()).system.config();
        const result = {
          bindings: config.keybindings,
          overrides: config.keybindingOverrides,
        };
        if (outputJson(opts, result)) return;
        console.log(JSON.stringify(result, null, 2));
      }),
    );
  keyboard
    .command("set <command> <shortcut>")
    .description("Set a command shortcut; use 'disabled' to clear it")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (commandInput: string, shortcut: string, opts: JsonOptions) => {
          const command = appCommandIdSchema.parse(commandInput);
          const sdk = createCliBbSdk(getUrl());
          const config = await sdk.system.config();
          const next = config.keybindingOverrides.filter(
            (item) => item.command !== command,
          );
          next.push({
            command,
            shortcut: shortcut === "disabled" ? null : parseShortcut(shortcut),
          });
          const result = await sdk.system.updateKeyboardSettings(next);
          if (outputJson(opts, result)) return;
          console.log(`Shortcut for ${command} updated`);
        },
      ),
    );
  keyboard
    .command("reset [command]")
    .description("Reset one command override or all keyboard overrides")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (commandInput: string | undefined, opts: JsonOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const config = await sdk.system.config();
        const next =
          commandInput === undefined
            ? []
            : config.keybindingOverrides.filter(
                (item) =>
                  item.command !== appCommandIdSchema.parse(commandInput),
              );
        const result = await sdk.system.updateKeyboardSettings(next);
        if (outputJson(opts, result)) return;
        console.log(
          commandInput
            ? `Shortcut for ${commandInput} reset`
            : "Keyboard overrides reset",
        );
      }),
    );

  settings
    .command("usage")
    .description("Show provider usage limits")
    .option(
      "--machine <id-or-name>",
      "Machine whose provider usage should be shown",
    )
    .option("--host <id-or-name>", "Alias for --machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: UsageOptions) => {
        const target = resolveMachineTargetOption(opts);
        const hostId =
          target === undefined
            ? undefined
            : await resolveMachineHostId({
                serverUrl: getUrl(),
                target,
              });
        const result = await createCliBbSdk(getUrl()).system.usageLimits(
          hostId === undefined ? {} : { hostId },
        );
        if (outputJson(opts, result)) return;
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  settings
    .command("version")
    .description("Check the running and latest BB versions")
    .option("--force", "Bypass the latest-version cache")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions & { force?: boolean }) => {
        const result = await createCliBbSdk(getUrl()).system.version({
          force: opts.force,
        });
        if (outputJson(opts, result)) return;
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  settings
    .command("reload")
    .description("Reload BB's managed configuration")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const result = await createCliBbSdk(getUrl()).system.reloadConfig();
        if (outputJson(opts, result)) return;
        console.log("Configuration reloaded");
      }),
    );
}
