import { z } from "zod";

const isoUtcDateTimeSchema = z.iso.datetime();

const bbDesktopVersionFeedFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const bbDesktopVersionFeedPlatformSchema = z.enum(["macos", "linux"]);
export type BbDesktopVersionFeedPlatform = z.infer<
  typeof bbDesktopVersionFeedPlatformSchema
>;

export const bbDesktopVersionFeedSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["latest", "nightly"]),
  platform: bbDesktopVersionFeedPlatformSchema,
  version: z.string().min(1),
  releaseDate: isoUtcDateTimeSchema,
  releaseName: z.string().min(1),
  releaseNotes: z.string().nullable(),
  minimumSystemVersion: z.string().min(1).nullable(),
  files: z.array(bbDesktopVersionFeedFileSchema).min(1),
  path: z.string().min(1),
  sha512: z.string().min(1),
  stagingPercentage: z.number().min(0).max(100).nullable(),
});
export type BbDesktopVersionFeed = z.infer<typeof bbDesktopVersionFeedSchema>;

const BB_DESKTOP_VERSION_FEED_FILE_NAMES = {
  linux: "desktop-version-linux.json",
  macos: "desktop-version.json",
} as const satisfies Record<BbDesktopVersionFeedPlatform, string>;

export function createBbDesktopVersionFeedFileName(
  platform: BbDesktopVersionFeedPlatform,
): string {
  return BB_DESKTOP_VERSION_FEED_FILE_NAMES[platform];
}
