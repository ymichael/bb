import { eq } from "drizzle-orm";
import {
  defaultAppTheme,
  defaultFaviconColor,
  type FaviconColorPreference,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { appTheme } from "../schema.js";

const APP_THEME_ROW_ID = "current";

export function getStoredThemeId(db: DbConnection): string {
  const row = db
    .select({ themeId: appTheme.themeId })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.themeId ?? defaultAppTheme.themeId;
}

export function getStoredFaviconColor(db: DbConnection): FaviconColorPreference {
  const row = db
    .select({ faviconColor: appTheme.faviconColor })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.faviconColor ?? defaultFaviconColor;
}

export function setStoredAppearance(
  db: DbConnection,
  appearance: { themeId: string; faviconColor: FaviconColorPreference },
): void {
  const updatedAt = Date.now();
  const { themeId, faviconColor } = appearance;
  db.insert(appTheme)
    .values({ id: APP_THEME_ROW_ID, themeId, faviconColor, updatedAt })
    .onConflictDoUpdate({
      target: appTheme.id,
      set: { themeId, faviconColor, updatedAt },
    })
    .run();
}
