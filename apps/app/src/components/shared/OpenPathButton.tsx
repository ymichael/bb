import type { OpenPathTarget } from "@bb/core";
import type { ReactNode } from "react";
import { openPathInEditor } from "@/lib/api";
import { getPathCommandForTarget } from "@/lib/open-path-preferences";
import { cn } from "@/lib/utils";

export function OpenPathButton({
  path,
  target,
  title,
  className,
  children,
}: {
  path: string;
  target: OpenPathTarget;
  title?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn("w-full truncate text-left text-xs underline underline-offset-2", className)}
      title={title ?? path}
      onClick={() => {
        void openPathInEditor(path, {
          target,
          command: getPathCommandForTarget(target),
        });
      }}
    >
      {children ?? path}
    </button>
  );
}
