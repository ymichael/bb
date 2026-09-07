
import type { AppBranding } from "./AppBranding.js";
import type { AppMetadata } from "./AppMetadata.js";

export type AppInfo = { id: string, name: string, description: string | null, logoUrl: string | null, logoUrlDark: string | null, iconAssets: { [key in string]?: string } | null, iconDarkAssets: { [key in string]?: string } | null, distributionChannel: string | null, branding: AppBranding | null, appMetadata: AppMetadata | null, labels: { [key in string]?: string } | null, installUrl: string | null, isAccessible: boolean,
isEnabled: boolean, pluginDisplayNames: Array<string>, };
