import { type ReactNode } from "react";
import { FilePreview } from "./FilePreview";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "secondary-panel/File preview",
};

// Mirror the secondary panel's surface: bg-background and the same horizontal
// padding the panel uses for its content area (px-4 pb-3 pt-1).
function PreviewStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[360px] w-full max-w-[640px] min-w-0 flex-col overflow-hidden bg-background px-4 pb-3 pt-1">
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

const SAMPLE_README_MD = `# Tabbed Shell

The secondary panel uses a **tabbed shell** to switch between Info, Diff, and
dynamic file previews opened from the timeline.

## Features

- Click a file in the diff to pin it as a tab
- Tabs persist until you close them with the \`×\` button
- The toggle on the right hides the entire panel

## Keyboard

| Key | Action |
| --- | --- |
| \`⌘ B\` | Toggle the panel |
| \`Esc\` | Close the active file tab |

> Closing the last tab returns focus to the Info tab.

\`\`\`ts
import { FilePreview } from "@/components/secondary-panel/FilePreview";

<FilePreview state={{ kind: "ready", file }} />;
\`\`\`
`;

const SAMPLE_BUTTON_TSX = `import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "outline";
  size?: "sm" | "md" | "lg";
}

const VARIANT_CLASS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  outline: "border border-input bg-background hover:bg-accent",
};

const SIZE_CLASS: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-9 px-4",
  lg: "h-10 px-6 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2",
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
`;

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="markdown file"
        hint="README.md is rendered with react-markdown + GFM (tables, code blocks, quotes)"
      >
        <PreviewStage>
          <FilePreview
            state={{
              kind: "ready",
              file: { name: "README.md", contents: SAMPLE_README_MD },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="typescript / react file"
        hint="Pierre File component highlights via Shiki (lang inferred from extension)"
      >
        <PreviewStage>
          <FilePreview
            state={{
              kind: "ready",
              file: {
                name: "Button.tsx",
                contents: SAMPLE_BUTTON_TSX,
                lang: "tsx",
              },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="empty file"
        hint="Content is an empty string — show an explicit empty state instead of a blank surface"
      >
        <PreviewStage>
          <FilePreview state={{ kind: "empty" }} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="file not found"
        hint="Preview fetch returned 404; the file isn't on disk"
      >
        <PreviewStage>
          <FilePreview state={{ kind: "not-found" }} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="manager status pending"
        hint="STATUS.md doesn't exist yet for a freshly-created manager — informational copy, no icon"
      >
        <PreviewStage>
          <FilePreview state={{ kind: "manager-status-pending" }} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="failed to load"
        hint="Preview fetch failed for some other reason (network, 500, etc.)"
      >
        <PreviewStage>
          <FilePreview state={{ kind: "error" }} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="loading"
        hint="Skeleton lines while file contents are being fetched"
      >
        <PreviewStage>
          <FilePreview state={{ kind: "loading" }} />
        </PreviewStage>
      </StoryRow>
    </StoryCard>
  );
}
