import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { ExperimentalFileLinkProps } from "@get-bb/plugin-sdk";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { normalizeExperimentalFileOpenOptions } from "@/lib/live-file-navigation";

const LazyExperimentalFileLinkMenu = lazy(() =>
  import("./ExperimentalFileLinkMenu").then(({ ExperimentalFileLinkMenu }) => ({
    default: ExperimentalFileLinkMenu,
  })),
);

function shouldHandleFileClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.currentTarget.hasAttribute("download")
  );
}

export function ExperimentalFileLink({
  target,
  location = null,
  onClick,
  ...anchorProps
}: ExperimentalFileLinkProps) {
  const navigation = useAppNavigationHost();
  const [isMenuOpen, setMenuOpen] = useState(false);
  const intent = useMemo(
    () => normalizeExperimentalFileOpenOptions({ target, location }),
    [location, target],
  );
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (intent === null || !shouldHandleFileClick(event)) {
        return;
      }
      event.preventDefault();
      navigation.openFilePreview(intent);
    },
    [intent, navigation, onClick],
  );
  const href =
    intent === null ? undefined : `./${encodeURIComponent(intent.target.path)}`;
  const anchor = (
    <RouteAnchor {...anchorProps} href={href} onClick={handleClick} />
  );

  if (intent === null) return anchor;
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {isMenuOpen ? (
          <Suspense
            fallback={<ContextMenuItem disabled>Loading…</ContextMenuItem>}
          >
            <LazyExperimentalFileLinkMenu intent={intent} />
          </Suspense>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
