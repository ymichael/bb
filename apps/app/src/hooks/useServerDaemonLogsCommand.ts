import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";

export function useServerDaemonLogsCommand(): void {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const openLogs = desktopApi?.openServerDaemonLogs;
  const enabled =
    openLogs !== undefined && desktopInfo?.serverDaemonLogsAvailable === true;

  useAppCommandHandler(
    "logs.openServerDaemon",
    () => {
      if (openLogs === undefined) {
        return false;
      }
      void openLogs.call(desktopApi).catch(() => undefined);
      return true;
    },
    0,
    enabled,
  );
}
