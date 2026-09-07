import { usePathname, useRouter } from "expo-router";
import { useEffect } from "react";
import { webViewShellHref } from "@/screens/shell/hrefs";
import { useProfiles } from "./ProfilesProvider";

export function ThreadOpenSignalHandler() {
  const { connection } = useProfiles();
  const router = useRouter();
  const pathname = usePathname();
  const realtime = connection?.client.realtime ?? null;
  useEffect(() => {
    if (!realtime) return;
    return realtime.onThreadOpen((signal) => {
      if (pathnameIsThread(pathname, signal.threadId)) return;
      router.push(webViewShellHref({ path: `/threads/${signal.threadId}` }));
    });
  }, [realtime, router, pathname]);
  return null;
}

function pathnameIsThread(pathname: string, threadId: string): boolean {
  return (
    pathname === `/threads/${threadId}` ||
    pathname.endsWith(`/threads/${threadId}`)
  );
}
