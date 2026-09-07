import { Command } from "commander";
import {
  builtInThemes,
  defaultAppTheme,
  defaultFaviconColor,
  faviconColorPreferenceSchema,
  FAVICON_COLORS,
  isBuiltInThemeId,
  type AppTheme,
  type FaviconColorPreference,
} from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

interface ThemeShowCommandOptions extends JsonOutputOptions {
  css?: boolean;
}

interface ThemeSetCommandOptions extends JsonOutputOptions {
  faviconColor?: string;
}

function parseFaviconColor(value: string): FaviconColorPreference {
  const parsed = faviconColorPreferenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid favicon color '${value}'. Expected one of: default, ${FAVICON_COLORS.join(
        ", ",
      )}.`,
    );
  }
  return parsed.data;
}

function describeActive(theme: AppTheme): string {
  if (!isBuiltInThemeId(theme.themeId)) {
    const bytes = theme.customCss?.length ?? 0;
    return `Custom theme '${theme.themeId}' (${bytes} bytes)`;
  }
  const meta = builtInThemes.find((entry) => entry.id === theme.themeId);
  return meta ? `${meta.name} (${meta.id})` : theme.themeId;
}

function describeCodeTheme(theme: AppTheme): string {
  const { dark, light } = theme.resolvedCodeTheme;
  return dark === light ? dark : `${dark} / ${light}`;
}

export function registerThemeCommands(
  program: Command,
  getUrl: () => string,
): void {
  const theme = program
    .command("theme")
    .description("Manage the app theme and favicon color");

  theme
    .command("list")
    .description("List built-in and custom themes and the active palette")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const catalog = await sdk.theme.catalog();
        if (
          outputJson(opts, {
            active: catalog.active,
            builtInThemes,
            custom: catalog.custom,
            plugins: catalog.plugins,
            dir: catalog.dir,
          })
        ) {
          return;
        }
        const active = catalog.active.themeId;
        console.log("");
        console.log("Built-in:");
        for (const entry of builtInThemes) {
          const marker = active === entry.id ? "*" : " ";
          console.log(`${marker} ${entry.id.padEnd(12)} ${entry.description}`);
        }
        console.log("");
        console.log(`Custom (${catalog.dir}):`);
        if (catalog.custom.length === 0) {
          console.log(
            `  (none — create <name>/theme.css under that directory)`,
          );
        } else {
          for (const name of catalog.custom) {
            const marker = active === name ? "*" : " ";
            console.log(`${marker} ${name}`);
          }
        }
        console.log("");
        console.log("Plugins:");
        if (catalog.plugins.length === 0) console.log("  (none)");
        for (const entry of catalog.plugins) {
          const marker = active === entry.id ? "*" : " ";
          console.log(`${marker} ${entry.id.padEnd(24)} ${entry.name}`);
        }
        console.log("");
        console.log(`Active: ${describeActive(catalog.active)}`);
        console.log(`Favicon color: ${catalog.active.faviconColor}`);
        console.log(`Code theme: ${describeCodeTheme(catalog.active)}`);
      }),
    );

  theme
    .command("set <id>")
    .description(
      "Switch to a built-in, custom, or plugin-contributed theme by id",
    )
    .option(
      "--favicon-color <color>",
      "Set the favicon color in the same appearance update",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ThemeSetCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const updated =
          opts.faviconColor === undefined
            ? await sdk.theme.set(id)
            : await sdk.theme.set({
                themeId: id,
                faviconColor: parseFaviconColor(opts.faviconColor),
              });
        if (outputJson(opts, updated)) return;
        console.log(`Theme set to ${describeActive(updated)}`);
      }),
    );

  theme
    .command("dir")
    .description("Print the directory where custom themes live")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const catalog = await sdk.theme.catalog();
        if (outputJson(opts, { dir: catalog.dir })) return;
        console.log(catalog.dir);
      }),
    );

  const favicon = theme
    .command("favicon")
    .description("Manage the app favicon color without changing the theme");

  favicon
    .command("set <color>")
    .description(
      `Set the favicon color (${FAVICON_COLORS.join(", ")}, or default)`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (color: string, opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const active = await sdk.theme.get();
        const updated = await sdk.theme.set({
          themeId: active.themeId,
          faviconColor: parseFaviconColor(color),
        });
        if (outputJson(opts, updated)) return;
        console.log(`Favicon color set to ${updated.faviconColor}`);
      }),
    );

  favicon
    .command("reset")
    .description("Reset the favicon color without changing the theme")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const active = await sdk.theme.get();
        const updated = await sdk.theme.set({
          themeId: active.themeId,
          faviconColor: defaultFaviconColor,
        });
        if (outputJson(opts, updated)) return;
        console.log(`Favicon color reset to ${updated.faviconColor}`);
      }),
    );

  theme
    .command("show")
    .description("Show the active theme and favicon color")
    .option("--css", "Print the active custom CSS (custom theme only)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ThemeShowCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const active = await sdk.theme.get();
        if (outputJson(opts, active)) return;
        if (opts.css) {
          if (active.customCss !== null) {
            console.log(active.customCss);
          } else {
            console.log(
              "// Built-in theme CSS is bundled in the app, not stored on disk.",
            );
          }
          return;
        }
        console.log(`Active: ${describeActive(active)}`);
        console.log(`Favicon color: ${active.faviconColor}`);
        console.log(`Code theme: ${describeCodeTheme(active)}`);
      }),
    );

  theme
    .command("reset")
    .description("Reset to the Default theme")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const updated = await sdk.theme.set(defaultAppTheme.themeId);
        if (outputJson(opts, updated)) return;
        console.log(`Theme reset to ${describeActive(updated)}`);
      }),
    );
}
