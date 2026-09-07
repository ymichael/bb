import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@bb/shared-ui/context-menu";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { useResolvedLiveFileTarget } from "@/hooks/useResolvedLiveFileTarget";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  getFileBasename,
  getExperimentalFileLocationStart,
} from "@/lib/live-file-navigation";
import { usePluginSlots } from "@/lib/plugin-slots";

function getFileExtension(path: string): string | null {
  const name = getFileBasename(path);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < name.length - 1
    ? name.slice(dotIndex + 1).toLowerCase()
    : null;
}

export function ExperimentalFileLinkMenu({
  intent,
}: {
  intent: ExperimentalFileOpenOptions;
}) {
  const navigation = useAppNavigationHost();
  const resolved = useResolvedLiveFileTarget(intent.target, { enabled: true });
  const localTargets = useLocalOpenTargets({
    enabled: resolved.status === "available",
    ...(resolved.status === "available"
      ? { openContext: resolved.openContext }
      : {}),
  });
  const { fileOpeners } = usePluginSlots();
  const extension = getFileExtension(intent.target.path);
  const matchingOpeners =
    extension === null
      ? []
      : fileOpeners.filter((opener) => opener.extensions.includes(extension));
  const location = getExperimentalFileLocationStart(intent.location);

  return (
    <>
      <ContextMenuItem onSelect={() => navigation.openFilePreview(intent)}>
        Open preview
      </ContextMenuItem>
      {matchingOpeners.length > 0 ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Open with</ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-52">
            <ContextMenuItem
              onSelect={() =>
                navigation.openFilePreview({ ...intent, viewer: "builtin" })
              }
            >
              BB preview
            </ContextMenuItem>
            {matchingOpeners.map((opener) => (
              <ContextMenuItem
                key={`${opener.pluginId}:${opener.id}`}
                onSelect={() =>
                  navigation.openFilePreview({
                    ...intent,
                    viewer: {
                      pluginId: opener.pluginId,
                      openerId: opener.id,
                    },
                  })
                }
              >
                {opener.title}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
      <ContextMenuItem
        disabled={
          resolved.status !== "available" ||
          localTargets.isLoading ||
          !localTargets.canOpenPreferredFileTarget
        }
        onSelect={() => navigation.openFileExternally(intent)}
      >
        Open externally
      </ContextMenuItem>
      {resolved.status === "available" &&
      localTargets.fileOpenTargets.length > 0 ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Open in</ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-52">
            {localTargets.fileOpenTargets.map((target) => (
              <ContextMenuItem
                key={target.id}
                onSelect={() => {
                  void localTargets.openPathInFileTarget({
                    columnNumber: location.columnNumber,
                    lineNumber: location.lineNumber,
                    path: resolved.absolutePath,
                    rememberTarget: false,
                    targetId: target.id,
                  });
                }}
              >
                {target.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          void copyToClipboardWithToast(
            resolved.status === "available"
              ? resolved.absolutePath
              : intent.target.path,
            {
              successMessage: "File path copied",
              errorMessage: "Failed to copy file path",
            },
          );
        }}
      >
        Copy file path
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          void copyToClipboardWithToast(getFileBasename(intent.target.path), {
            successMessage: "File name copied",
            errorMessage: "Failed to copy file name",
          });
        }}
      >
        Copy file name
      </ContextMenuItem>
    </>
  );
}
