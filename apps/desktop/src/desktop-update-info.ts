import type { BbDesktopInfo } from "@bb/desktop-contract";

interface MergeDesktopUpdateInfoArgs {
  autoInfo: BbDesktopInfo | null;
  feedInfo: BbDesktopInfo | null;
}

function latestCheckedAt(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left > right ? left : right;
}

export function mergeDesktopUpdateInfo(
  args: MergeDesktopUpdateInfoArgs,
): BbDesktopInfo | null {
  const baseInfo = args.feedInfo ?? args.autoInfo;
  if (baseInfo === null) {
    return null;
  }

  const feedUpdateAvailable = args.feedInfo?.updateAvailable ?? false;
  const autoUpdateAvailable = args.autoInfo?.updateAvailable ?? false;
  const updateDownloaded = args.autoInfo?.updateDownloaded ?? false;
  const pendingVersion = args.autoInfo?.pendingVersion ?? null;
  const latestVersion =
    pendingVersion ??
    args.feedInfo?.latestVersion ??
    args.autoInfo?.latestVersion ??
    null;
  const nativeDownloadState = args.autoInfo?.downloadState;

  return {
    ...baseInfo,
    ...(nativeDownloadState === undefined
      ? {}
      : { downloadState: nativeDownloadState }),
    lastCheckedAt: latestCheckedAt(
      args.feedInfo?.lastCheckedAt ?? null,
      args.autoInfo?.lastCheckedAt ?? null,
    ),
    latestVersion,
    pendingVersion,
    updateAvailable:
      feedUpdateAvailable || autoUpdateAvailable || updateDownloaded,
    updateDownloaded,
  };
}
