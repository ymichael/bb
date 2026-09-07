import { waitForActiveConnection } from "@/app-shell/connector";
import { e2eModeEnabled } from "@/app-shell/e2e";
import { addServerPathForLink } from "@/lib/links";
import { getProfileStore } from "@/lib/native";
import { resolveShellIncomingLink } from "@/lib/shell";

export async function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): Promise<string> {
  try {
    const store = getProfileStore();
    await store.load();
    const snapshot = store.getSnapshot();
    const context = {
      profiles: snapshot.profiles,
      activeProfileId: snapshot.activeProfileId,
      developerRoutesEnabled: e2eModeEnabled,
    };
    const resolution = resolveShellIncomingLink(path, context);
    switch (resolution.kind) {
      case "passthrough":
        return path;
      case "navigate":
        if (resolution.profileId !== null) {
          await store.setActiveProfile(resolution.profileId);
          await waitForActiveConnection(resolution.profileId);
        }
        return resolution.path;
      case "unknown-server":
        return addServerPathForLink(resolution.serverUrl, resolution.path);
    }
  } catch (error) {
    console.warn("Could not resolve incoming link", path, error);
    return "/";
  }
}
