import { useEffect, useState } from "react";
import type { BbDesktopApi, BbDesktopInfo } from "@bb/desktop-contract";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

interface DesktopUpdateInfo {
  desktopApi: BbDesktopApi | null;
  desktopInfo: BbDesktopInfo | null;
  isDesktop: boolean;
}

export function useDesktopUpdateInfo(): DesktopUpdateInfo {
  const [desktopApi] = useState<BbDesktopApi | null>(() => getBbDesktopInfo());
  const [desktopInfo, setDesktopInfo] = useState<BbDesktopInfo | null>(null);

  useEffect(() => {
    const api = getBbDesktopInfo();
    if (api === null) {
      return;
    }

    let mounted = true;
    void api
      .getInfo()
      .then((info) => {
        if (mounted) {
          setDesktopInfo(info);
        }
      })
      .catch(() => undefined);
    const unsubscribe = api.onChange((info) => {
      setDesktopInfo(info);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { desktopApi, desktopInfo, isDesktop: desktopApi !== null };
}
