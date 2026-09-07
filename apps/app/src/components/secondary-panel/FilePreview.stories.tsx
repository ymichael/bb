import { type ReactNode } from "react";
import { FilePreview } from "./FilePreview";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "right-panel/File preview",
};

function PreviewStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[360px] w-full max-w-[640px] min-w-0 flex-col overflow-hidden bg-background px-4 pb-3 pt-1">
      <div
        className="min-h-0 flex-1 overflow-auto"
        data-file-preview-scroll-container
      >
        {children}
      </div>
    </div>
  );
}

const SAMPLE_README_MD = `# Tabbed Shell

The right panel uses a **tabbed shell** to switch between Info, Diff, Terminal,
and dynamic previews opened from the timeline.

## Features

- Click a file in the diff to pin it as a tab
- Tabs persist until you close them with the \`×\` button
- The right-panel toggle hides the entire panel

## Keyboard

| Key | Action |
| --- | --- |
| \`⌘ B\` | Toggle the right panel |
| \`Esc\` | Close the active file tab |

> Closing the last tab returns focus to the Info tab.

\`\`\`ts
import { FilePreview } from "...";

<FilePreview
  state={{
    kind: "ready",
    lineRange: null,
    textPreviewKind: "markdown",
    file,
  }}
/>;
\`\`\`
`;

const SAMPLE_DIAGRAM_MD = `# Preview Flow

Markdown file previews render Mermaid fences directly in Preview mode.

\`\`\`mermaid
flowchart LR
  Open[Open markdown file] --> Preview[Rendered preview]
  Preview --> Raw[Raw source toggle]
  Raw --> Preview
\`\`\`

The Raw toggle still shows this markdown source unchanged.`;

const SAMPLE_BUTTON_TSX = `import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@bb/shared-ui/lib/utils";

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

const SAMPLE_METRICS_CSV = `Name,Status,Revenue,Notes
Ada Lovelace,Active,12800,"Renewal call booked, asked for CSV export"
Grace Hopper,Trial,4200,"Prefers yearly billing"
Katherine Johnson,Active,9600,"Needs ""Executive Summary"" column added"
`;

const README_PATH = "docs/right-panel/README.md";
const DIAGRAM_PATH = "docs/right-panel/preview-flow.md";
const BUTTON_PATH = "apps/app/src/components/ui/button.tsx";
const DELETED_BUTTON_PATH = "apps/app/src/components/ui/legacy-button.tsx";
const METRICS_PATH = "reports/customers.csv";
const SCREENSHOT_PATH = "docs/screenshots/right-panel.svg";
const STORY_WORKSPACE_ROOT = "/Users/alex/Code/bb";

function copyPathFor(path: string) {
  return `${STORY_WORKSPACE_ROOT}/${path}`;
}

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

const LARGE_FILE_LINE_COUNT = 8_000;
const LARGE_FILE_TARGET_LINE = 6_500;
const SAMPLE_LARGE_TS = Array.from({ length: LARGE_FILE_LINE_COUNT }, (_, i) =>
  i % 40 === 0
    ? `export function block${i / 40}(input: number): number {`
    : i % 40 === 39
      ? "}"
      : `  const step${i % 40} = input * ${i} + ${(i * 7) % 13}; // line ${i + 1}`,
).join("\n");

function noopOpenInEditor(path: string) {
  console.log("open in editor:", path);
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="markdown file"
        hint="Header shows a copyable path, direct markdown-copy icon, open-in-editor icon, and Preview/Raw toggle"
      >
        <PreviewStage>
          <FilePreview
            path={README_PATH}
            copyPath={copyPathFor(README_PATH)}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineRange: null,
              textPreviewKind: "markdown",
              file: { name: "README.md", contents: SAMPLE_README_MD },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="markdown file with Mermaid"
        hint="Preview mode renders the Mermaid diagram; the header copy icon copies the original markdown"
      >
        <PreviewStage>
          <FilePreview
            path={DIAGRAM_PATH}
            copyPath={copyPathFor(DIAGRAM_PATH)}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineRange: null,
              textPreviewKind: "markdown",
              file: { name: "preview-flow.md", contents: SAMPLE_DIAGRAM_MD },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="CSV file"
        hint="CSV previews render as a table with a Raw toggle for the original source"
      >
        <PreviewStage>
          <FilePreview
            path={METRICS_PATH}
            copyPath={copyPathFor(METRICS_PATH)}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineRange: null,
              textPreviewKind: "csv",
              file: { name: "customers.csv", contents: SAMPLE_METRICS_CSV },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="typescript / react file"
        hint="Code previews use direct content-copy and line-wrap controls without an overflow menu"
      >
        <PreviewStage>
          <FilePreview
            path={BUTTON_PATH}
            copyPath={copyPathFor(BUTTON_PATH)}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineRange: null,
              textPreviewKind: null,
              file: {
                name: "Button.tsx",
                contents: SAMPLE_BUTTON_TSX,
              },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="large file (capped)"
        hint={`${LARGE_FILE_LINE_COUNT.toLocaleString()} lines: only the leading prefix renders until "Load full file"; rows are virtualized inside the code viewport`}
      >
        <PreviewStage>
          <FilePreview
            path="src/generated/large.ts"
            copyPath={copyPathFor("src/generated/large.ts")}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineRange: null,
              textPreviewKind: null,
              file: {
                cacheKey: "story:large.ts",
                name: "large.ts",
                contents: SAMPLE_LARGE_TS,
              },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="large file (line link past the cap)"
        hint={`Opened at line ${LARGE_FILE_TARGET_LINE.toLocaleString()}: the whole file renders and the virtualized viewport scrolls the target into view`}
      >
        <PreviewStage>
          <FilePreview
            path="src/generated/large.ts"
            copyPath={copyPathFor("src/generated/large.ts")}
            onOpenInEditor={noopOpenInEditor}
            state={{
              kind: "ready",
              lineRange: {
                startLineNumber: LARGE_FILE_TARGET_LINE,
                endLineNumber: LARGE_FILE_TARGET_LINE,
              },
              textPreviewKind: null,
              file: {
                cacheKey: "story:large.ts",
                name: "large.ts",
                contents: SAMPLE_LARGE_TS,
              },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="code in a content-sized scroller"
        hint="Skill detail embeds headerless code previews in a max-height scroller with no fixed height; the code viewport grows with its content and the outer box scrolls"
      >
        <div className="w-full max-w-[640px] bg-background px-4 py-2">
          <div className="max-h-[300px] overflow-y-auto overscroll-contain rounded-md border border-border">
            <FilePreview
              path="skills/writing-voice/scripts/lint.ts"
              headerMode="none"
              state={{
                kind: "ready",
                lineRange: null,
                textPreviewKind: null,
                file: {
                  cacheKey: "story:skill-script",
                  name: "lint.ts",
                  contents: SAMPLE_LARGE_TS.split("\n")
                    .slice(0, 400)
                    .join("\n"),
                },
              }}
            />
          </div>
        </div>
      </StoryRow>
      <StoryRow
        label="deleted file"
        hint="Opened from HEAD or the merge base; a muted (deleted) tag sits next to the path"
      >
        <PreviewStage>
          <FilePreview
            path={DELETED_BUTTON_PATH}
            copyPath={copyPathFor(DELETED_BUTTON_PATH)}
            onOpenInEditor={noopOpenInEditor}
            statusLabel="deleted"
            state={{
              kind: "ready",
              lineRange: null,
              textPreviewKind: null,
              file: {
                name: "legacy-button.tsx",
                contents: SAMPLE_BUTTON_TSX,
              },
            }}
          />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="image file"
        hint="Image previews keep the same copyable path and open-in-editor header chrome"
      >
        <PreviewStage>
          <FilePreview
            path={SCREENSHOT_PATH}
            copyPath={copyPathFor(SCREENSHOT_PATH)}
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
            copyPath={copyPathFor(README_PATH)}
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
            copyPath={copyPathFor(README_PATH)}
            onOpenInEditor={noopOpenInEditor}
            state={{ kind: "not-found" }}
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
            copyPath={copyPathFor(README_PATH)}
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
            copyPath={copyPathFor(README_PATH)}
            onOpenInEditor={noopOpenInEditor}
            state={{ kind: "loading" }}
          />
        </PreviewStage>
      </StoryRow>
    </StoryCard>
  );
}
