import type {
  AppUpdater,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";
import type {
  BbDesktopInfo,
  BbDesktopInfoChangeHandler,
  BbDesktopInfoUnsubscribe,
} from "@bb/desktop-contract";
import {
  DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS,
  DESKTOP_UPDATE_CHECK_INTERVAL_MS,
  type DesktopUpdateService,
} from "./desktop-update-check.js";
import {
  DESKTOP_AUTO_UPDATE_FEED_CONFIG,
  type DesktopAutoUpdateFeedConfig,
} from "./desktop-update-provider.js";

export interface DesktopAutoUpdateLogger {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export type DesktopAutoUpdateAvailableHandler = (info: UpdateInfo) => void;
export type DesktopAutoUpdateDownloadedHandler = (
  event: UpdateDownloadedEvent,
) => void;
export type DesktopAutoUpdateNotAvailableHandler = (info: UpdateInfo) => void;

export interface DesktopAutoUpdateErrorArgs {
  error: Error;
  message: string | null;
}

export type DesktopAutoUpdateErrorHandler = (
  args: DesktopAutoUpdateErrorArgs,
) => void;

export interface DesktopAutoUpdaterAdapter {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<Array<string>>;
  onError(handler: DesktopAutoUpdateErrorHandler): void;
  onUpdateAvailable(handler: DesktopAutoUpdateAvailableHandler): void;
  onUpdateDownloaded(handler: DesktopAutoUpdateDownloadedHandler): void;
  onUpdateNotAvailable(handler: DesktopAutoUpdateNotAvailableHandler): void;
  quitAndInstall(): void;
  setAutoDownload(enabled: boolean): void;
  setAutoInstallOnAppQuit(enabled: boolean): void;
  setFeedURL(config: DesktopAutoUpdateFeedConfig): void;
  setForceDevUpdateConfig(enabled: boolean): void;
  setLogger(logger: DesktopAutoUpdateLogger): void;
}

interface CreateDesktopAutoUpdateServiceArgs {
  currentVersion: string;
  enabled: boolean;
  forceDevUpdateConfig: boolean;
  logger?: DesktopAutoUpdateLogger;
  now?: () => number;
  platform: BbDesktopInfo["platform"];
  updater: DesktopAutoUpdaterAdapter;
}

interface ShouldEnableDesktopAutoUpdateArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}

interface ApplyUpdateAvailableArgs {
  checkedAt: string;
  version: string;
}

interface ApplyUpdateDownloadedArgs {
  checkedAt: string;
  version: string;
}

interface ApplyUpdateNotAvailableArgs {
  checkedAt: string;
  version: string;
}

type DesktopUpdateIntervalHandle = ReturnType<typeof setInterval>;

export interface DesktopAutoUpdateService extends DesktopUpdateService {
  installUpdate(): void;
}

function createBaseInfo(
  currentVersion: string,
  platform: BbDesktopInfo["platform"],
): BbDesktopInfo {
  return {
    downloadState: "idle",
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform,
    updateAvailable: false,
    updateDownloaded: false,
    version: currentVersion,
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function createDefaultLogger(): DesktopAutoUpdateLogger {
  return {
    error(message) {
      console.error(message);
    },
    info(message) {
      console.info(message);
    },
    warn(message) {
      console.warn(message);
    },
  };
}

function areDesktopInfoValuesEqual(
  left: BbDesktopInfo,
  right: BbDesktopInfo,
): boolean {
  return (
    left.lastCheckedAt === right.lastCheckedAt &&
    left.downloadState === right.downloadState &&
    left.latestVersion === right.latestVersion &&
    left.pendingVersion === right.pendingVersion &&
    left.platform === right.platform &&
    left.updateAvailable === right.updateAvailable &&
    left.updateDownloaded === right.updateDownloaded &&
    left.version === right.version
  );
}

function formatCheckedAt(now: () => number): string {
  return new Date(now()).toISOString();
}

export function shouldEnableDesktopAutoUpdate(
  args: ShouldEnableDesktopAutoUpdateArgs,
): boolean {
  return args.isPackaged || args.env.BB_DESKTOP_AUTO_UPDATE === "1";
}

export function createElectronAutoUpdaterAdapter(
  updater: AppUpdater,
): DesktopAutoUpdaterAdapter {
  return {
    checkForUpdates() {
      return updater.checkForUpdates();
    },
    downloadUpdate() {
      return updater.downloadUpdate();
    },
    onError(handler) {
      updater.on("error", (error, message) => {
        handler({ error, message: message ?? null });
      });
    },
    onUpdateAvailable(handler) {
      updater.on("update-available", handler);
    },
    onUpdateDownloaded(handler) {
      updater.on("update-downloaded", handler);
    },
    onUpdateNotAvailable(handler) {
      updater.on("update-not-available", handler);
    },
    quitAndInstall() {
      updater.quitAndInstall();
    },
    setAutoDownload(enabled) {
      updater.autoDownload = enabled;
    },
    setAutoInstallOnAppQuit(enabled) {
      updater.autoInstallOnAppQuit = enabled;
    },
    setFeedURL(config) {
      updater.setFeedURL(config);
    },
    setForceDevUpdateConfig(enabled) {
      updater.forceDevUpdateConfig = enabled;
    },
    setLogger(logger) {
      updater.logger = logger;
    },
  };
}

export function createDesktopAutoUpdateService(
  args: CreateDesktopAutoUpdateServiceArgs,
): DesktopAutoUpdateService {
  const logger = args.logger ?? createDefaultLogger();
  const now = args.now ?? (() => Date.now());

  let currentInfo = createBaseInfo(args.currentVersion, args.platform);
  let inflight: Promise<BbDesktopInfo> | null = null;
  let intervalHandle: DesktopUpdateIntervalHandle | null = null;
  let lastAttemptedAt: number | null = null;
  let downloadInFlight: Promise<Array<string>> | null = null;
  const listeners = new Set<BbDesktopInfoChangeHandler>();

  function updateInfo(nextInfo: BbDesktopInfo): void {
    if (areDesktopInfoValuesEqual(currentInfo, nextInfo)) {
      return;
    }
    currentInfo = nextInfo;
    for (const listener of listeners) {
      listener(currentInfo);
    }
  }

  function applyUpdateAvailable(
    applyArgs: ApplyUpdateAvailableArgs,
  ): BbDesktopInfo {
    updateInfo({
      ...currentInfo,
      lastCheckedAt: applyArgs.checkedAt,
      latestVersion: applyArgs.version,
      updateAvailable: true,
    });
    return currentInfo;
  }

  function applyUpdateDownloaded(
    applyArgs: ApplyUpdateDownloadedArgs,
  ): BbDesktopInfo {
    updateInfo({
      ...currentInfo,
      downloadState: "downloaded",
      lastCheckedAt: applyArgs.checkedAt,
      latestVersion: applyArgs.version,
      pendingVersion: applyArgs.version,
      updateAvailable: true,
      updateDownloaded: true,
    });
    return currentInfo;
  }

  function applyUpdateNotAvailable(
    applyArgs: ApplyUpdateNotAvailableArgs,
  ): BbDesktopInfo {
    updateInfo({
      ...currentInfo,
      downloadState: "idle",
      lastCheckedAt: applyArgs.checkedAt,
      latestVersion: applyArgs.version,
      pendingVersion: null,
      updateAvailable: false,
      updateDownloaded: false,
    });
    return currentInfo;
  }

  function startDownload(): void {
    if (downloadInFlight !== null) {
      return;
    }
    updateInfo({
      ...currentInfo,
      downloadState: "downloading",
    });
    try {
      downloadInFlight = args.updater.downloadUpdate();
    } catch (error: unknown) {
      updateInfo({
        ...currentInfo,
        downloadState: "failed",
      });
      logger.error(
        `Desktop auto-update download failed; preserving current update state: ${formatErrorMessage(
          error,
        )}`,
      );
      return;
    }
    void downloadInFlight
      .catch((error: unknown) => {
        updateInfo({
          ...currentInfo,
          downloadState: "failed",
        });
        logger.error(
          `Desktop auto-update download failed; preserving current update state: ${formatErrorMessage(
            error,
          )}`,
        );
      })
      .finally(() => {
        downloadInFlight = null;
      });
  }

  async function checkForUpdates(): Promise<BbDesktopInfo> {
    if (!args.enabled) {
      return currentInfo;
    }
    if (currentInfo.updateDownloaded) {
      return currentInfo;
    }
    if (inflight !== null) {
      return inflight;
    }

    const requestPromise = (async () => {
      lastAttemptedAt = now();
      const checkedAt = new Date(lastAttemptedAt).toISOString();

      let result: UpdateCheckResult | null;
      try {
        result = await args.updater.checkForUpdates();
      } catch (error: unknown) {
        logger.error(
          `Desktop auto-update check failed; update installation remains disabled until a later check succeeds: ${formatErrorMessage(
            error,
          )}`,
        );
        updateInfo({
          ...currentInfo,
          lastCheckedAt: checkedAt,
        });
        return currentInfo;
      }

      if (result === null) {
        return currentInfo;
      }
      if (result.isUpdateAvailable) {
        return applyUpdateAvailable({
          checkedAt,
          version: result.updateInfo.version,
        });
      }
      return applyUpdateNotAvailable({
        checkedAt,
        version: result.updateInfo.version,
      });
    })();

    inflight = requestPromise;
    try {
      return await requestPromise;
    } finally {
      if (inflight === requestPromise) {
        inflight = null;
      }
    }
  }

  if (args.enabled) {
    args.updater.setLogger(logger);
    args.updater.setFeedURL(DESKTOP_AUTO_UPDATE_FEED_CONFIG);
    args.updater.setAutoDownload(false);
    args.updater.setAutoInstallOnAppQuit(true);
    args.updater.setForceDevUpdateConfig(args.forceDevUpdateConfig);
    args.updater.onUpdateAvailable((info) => {
      logger.info(
        `Desktop auto-update available: ${info.version}; downloading in background.`,
      );
      applyUpdateAvailable({
        checkedAt: formatCheckedAt(now),
        version: info.version,
      });
      startDownload();
    });
    args.updater.onUpdateDownloaded((event) => {
      logger.info(
        `Desktop auto-update downloaded: ${event.version}; it will install on restart or quit.`,
      );
      applyUpdateDownloaded({
        checkedAt: formatCheckedAt(now),
        version: event.version,
      });
    });
    args.updater.onUpdateNotAvailable((info) => {
      logger.info(`Desktop auto-update not available: ${info.version}.`);
      applyUpdateNotAvailable({
        checkedAt: formatCheckedAt(now),
        version: info.version,
      });
    });
    args.updater.onError((errorArgs) => {
      const suffix = errorArgs.message === null ? "" : ` ${errorArgs.message}`;
      logger.error(
        `Desktop auto-update error; preserving current update state.${suffix} ${formatErrorMessage(
          errorArgs.error,
        )}`,
      );
      if (currentInfo.downloadState === "downloading") {
        updateInfo({
          ...currentInfo,
          downloadState: "failed",
        });
      }
    });
  }

  return {
    async checkAfterActive(): Promise<BbDesktopInfo | null> {
      if (!args.enabled) {
        return null;
      }
      const currentTime = now();
      if (
        lastAttemptedAt !== null &&
        currentTime - lastAttemptedAt < DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS
      ) {
        return currentInfo;
      }
      return checkForUpdates();
    },
    checkForUpdates,
    getInfo(): BbDesktopInfo {
      return currentInfo;
    },
    installUpdate(): void {
      if (!currentInfo.updateDownloaded) {
        logger.warn(
          "Desktop auto-update install requested before an update was downloaded; ignoring.",
        );
        return;
      }
      args.updater.quitAndInstall();
    },
    start(): void {
      if (!args.enabled || intervalHandle !== null) {
        return;
      }
      void checkForUpdates();
      intervalHandle = setInterval(() => {
        void checkForUpdates();
      }, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
    },
    stop(): void {
      if (intervalHandle === null) {
        return;
      }
      clearInterval(intervalHandle);
      intervalHandle = null;
    },
    subscribe(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
