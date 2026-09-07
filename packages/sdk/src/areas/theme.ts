import type { AppTheme, AppThemeSelection } from "@bb/domain";
import type { ThemeCatalogResponse } from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type ThemeGetResult = AppTheme;
export type ThemeCatalogResult = ThemeCatalogResponse;
export type ThemeSetInput = AppThemeSelection;
export type ThemeSetResult = AppTheme;

export interface ThemeCatalogArgs {
  signal?: AbortSignal;
}

export interface ThemeGetArgs {
  signal?: AbortSignal;
}

export interface ThemeArea {
  get(args?: ThemeGetArgs): Promise<ThemeGetResult>;
  catalog(args?: ThemeCatalogArgs): Promise<ThemeCatalogResult>;
  set(selection: ThemeSetInput): Promise<ThemeSetResult>;
  set(themeId: string): Promise<ThemeSetResult>;
}

export function createThemeArea(args: CreateSdkAreaArgs): ThemeArea {
  const { transport } = args;
  return {
    async get(input = {}) {
      const config = await transport.readJson(
        transport.api.v1.system.config.$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
      return config.appearance;
    },
    async catalog(input = {}) {
      return transport.readJson(
        transport.api.v1.settings.themes.$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async set(input) {
      if (typeof input === "string") {
        const appearance = (
          await transport.readJson(transport.api.v1.system.config.$get())
        ).appearance;
        return transport.readJson(
          transport.api.v1.settings.appearance.$put({
            json: {
              themeId: input,
              faviconColor: appearance.faviconColor,
            },
          }),
        );
      }
      return transport.readJson(
        transport.api.v1.settings.appearance.$put({ json: input }),
      );
    },
  };
}
