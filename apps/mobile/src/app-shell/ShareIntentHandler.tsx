import { useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import {
  composeSeedFromShareIntent,
  loadShareIntentModule,
  type ShareIntentModule,
} from "@/lib/share";
import { webViewShellHref } from "@/screens/shell/hrefs";
import { toast } from "@/ui";
import { useProfiles } from "./ProfilesProvider";

export function ShareIntentHandler() {
  const module = useMemo(() => loadShareIntentModule(), []);
  if (module === null) return null;
  return <ShareIntentHandlerWithModule module={module} />;
}

function ShareIntentHandlerWithModule({
  module,
}: {
  module: ShareIntentModule;
}) {
  const router = useRouter();
  const { activeProfile } = useProfiles();
  const { hasShareIntent, shareIntent, resetShareIntent, error } =
    module.useShareIntent({ resetOnBackground: true });
  useEffect(() => {
    if (error) {
      toast.error("Could not read the shared content", { description: error });
    }
  }, [error]);
  useEffect(() => {
    if (!hasShareIntent) return;
    resetShareIntent();
    if (activeProfile === null) {
      toast.info("Add a server first, then share again.");
      return;
    }
    const seed = composeSeedFromShareIntent(shareIntent);
    if (seed === null) {
      toast.info("Only text and links can be sent to bb for now.");
      return;
    }
    router.navigate(
      webViewShellHref({
        path: `/?initialPrompt=${encodeURIComponent(seed.initialPrompt)}`,
      }),
    );
  }, [activeProfile, hasShareIntent, resetShareIntent, router, shareIntent]);
  return null;
}
