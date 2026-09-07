import type { IconName } from "@bb/shared-ui/icon";
import { SETTINGS_ROUTE_PATH, getSettingsRoutePath } from "@/lib/route-paths";

export const SETTINGS_NAV_SECTIONS = [
  { icon: "Settings", id: "general", label: "General" },
  { icon: "Bot", id: "providers", label: "Providers" },
  { icon: "Palette", id: "appearance", label: "Appearance" },
  { icon: "SlidersHorizontal", id: "keyboard", label: "Keyboard" },
  { icon: "ChartColumn", id: "usage", label: "Usage limits" },
  { icon: "Folder", id: "files", label: "Files" },
  { icon: "Laptop", id: "machines", label: "Machines" },
  { icon: "PackageReceive", id: "updates", label: "Updates" },
  { icon: "ElectricPlugs", id: "plugins", label: "Installed plugins" },
  { icon: "Puzzle", id: "marketplaces", label: "Plugin marketplaces" },
  { icon: "Beaker", id: "experiments", label: "Experiments" },
  { icon: "MessageSquare", id: "community", label: "Community" },
  { icon: "Archive", id: "archived", label: "Archived threads" },
] as const satisfies readonly {
  icon: IconName;
  id: string;
  label: string;
}[];

export type SettingsNavSection = (typeof SETTINGS_NAV_SECTIONS)[number];

export type SettingsSectionId = SettingsNavSection["id"];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_NAV_SECTIONS.some((section) => section.id === value);
}

export function getSettingsSectionRoutePath(
  sectionId: SettingsSectionId,
): string {
  return sectionId === "general"
    ? SETTINGS_ROUTE_PATH
    : getSettingsRoutePath(sectionId);
}
