import { FilePathLink } from "./file-path-link";

export default {
  title: "Primitives/FilePathLink",
};

const longPath =
  "/Users/michael/src/bb/apps/app/src/components/thread-timeline/TimelineFileDiffBlock.tsx";

export function StaticAndClickable() {
  return (
    <div className="grid max-w-md gap-3 p-6">
      <FilePathLink path={longPath} />
      <FilePathLink
        path={longPath}
        displayName="TimelineFileDiffBlock.tsx"
        onClick={ignoreClick}
      />
      <FilePathLink
        path={longPath}
        displayName="Open in editor"
        onClick={ignoreClick}
        variant="external"
      />
    </div>
  );
}

export function InNarrowRows() {
  return (
    <div className="grid max-w-xs gap-2 p-6">
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border p-3">
        <FilePathLink path={longPath} />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border p-3">
        <FilePathLink
          path="/tmp/bb/screenshots/thread-detail.png"
          onClick={ignoreClick}
          variant="external"
        />
      </div>
    </div>
  );
}

function ignoreClick(): void {}
