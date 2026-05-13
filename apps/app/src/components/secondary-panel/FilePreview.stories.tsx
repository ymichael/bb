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

<FilePreview state={{ kind: "ready", lineNumber: null, file }} />;
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

const README_PATH = "docs/secondary-panel/README.md";
const BUTTON_PATH = "apps/app/src/components/ui/button.tsx";
const STATUS_PATH = "agents/manager-42/STATUS.md";
const SCREENSHOT_PATH = "docs/screenshots/secondary-panel.svg";

const SAMPLE_IMAGE_URL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7c3aed"/>
          <stop offset="100%" stop-color="#2563eb"/>
        </linearGradient>
      </defs>
      <rect width="480" height="280" fill="url(#g)"/>
      <circle cx="240" cy="120" r="56" fill="#fef3c7" opacity="0.92"/>
      <rect x="80" y="200" width="320" height="14" rx="7" fill="#ffffff" opacity="0.85"/>
      <rect x="120" y="226" width="240" height="10" rx="5" fill="#ffffff" opacity="0.6"/>
    </svg>`,
  );

function noopOpenInEditor(path: string) {
  // Stories don't actually open anything; the prop is wired so the
  // open-in-editor affordance renders in the header.
  console.log("open in editor:", path);
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="markdown file"
        hint="Header shows path + Preview/Raw toggle; body renders with react-markdown + GFM"
      >
        <PreviewStage>
          <FilePreview
            path={README_PATH}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineNumber: null,
              file: { name: "README.md", contents: SAMPLE_README_MD },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="typescript / react file"
        hint="No markdown toggle for code files; Pierre File highlights via Shiki"
      >
        <PreviewStage>
          <FilePreview
            path={BUTTON_PATH}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineNumber: null,
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
        label="image file"
        hint="Image previews render inside the same header chrome (path, copy, open-in-editor)"
      >
        <PreviewStage>
          <FilePreview
            path={SCREENSHOT_PATH}
            onOpenInEditor={noopOpenInEditor}
            state={{ kind: "image", url: SAMPLE_IMAGE_URL }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="empty file"
        hint="Header still visible; body shows the dashed empty-state card"
      >
        <PreviewStage>
          <FilePreview
            path={README_PATH}
            onOpenInEditor={noopOpenInEditor}
            state={{ kind: "empty" }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="file not found"
        hint="Preview fetch returned 404; the file isn't on disk"
      >
        <PreviewStage>
          <FilePreview
            path={README_PATH}
            onOpenInEditor={noopOpenInEditor}
            state={{ kind: "not-found" }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="manager status pending"
        hint="STATUS.md doesn't exist yet for a freshly-created manager"
      >
        <PreviewStage>
          <FilePreview
            path={STATUS_PATH}
            state={{ kind: "manager-status-pending" }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="failed to load"
        hint="Preview fetch failed for some other reason (network, 500, etc.)"
      >
        <PreviewStage>
          <FilePreview
            path={README_PATH}
            onOpenInEditor={noopOpenInEditor}
            state={{ kind: "error" }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="loading"
        hint="Skeleton lines while file contents are being fetched"
      >
        <PreviewStage>
          <FilePreview
            path={README_PATH}
            onOpenInEditor={noopOpenInEditor}
            state={{ kind: "loading" }}
          />
        </PreviewStage>
      </StoryRow>
    </StoryCard>
  );
}
